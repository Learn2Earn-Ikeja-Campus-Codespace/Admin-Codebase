/**
 * GitHub Class Enrollment Automation
 * ==================================
 *
 * PURPOSE
 * -------
 * Automatically enroll students into a GitHub Organization from
 * Google Form submissions.
 *
 * WORKFLOW
 * --------
 * Google Form
 *     ↓
 * Form Responses 1
 *     ↓
 * onFormSubmit(e)
 *     ↓
 * GitHub Invitations → Pending
 *     ↓
 * processPendingInvitations()
 *     ↓
 * processInvitationRow(rowNumber)
 *     ↓
 * GitHub API
 *     ↓
 * Member / Invited / Error
 *
 *
 * GOOGLE SHEETS
 * -------------
 * Source sheet:
 *     Form Responses 1
 *
 * Processing sheet:
 *     GitHub Invitations
 *
 * GitHub Invitations columns:
 *
 * A  Timestamp
 * B  Full Name
 * C  GitHub Username
 * D  Email
 * E  Status
 * F  GitHub User ID
 * G  Invitation ID
 * H  Error
 * I  Processed At
 *
 *
 * STATUS VALUES
 * -------------
 * Pending
 *     Student is waiting to be processed.
 *
 * Invited
 *     GitHub invitation was successfully created.
 *
 * Member
 *     Student is already an organization member.
 *
 * Error
 *     Processing failed with a non-retryable error.
 *
 *
 * SCRIPT PROPERTIES
 * -----------------
 * The following properties must exist in Apps Script:
 *
 * GITHUB_TOKEN
 *     GitHub Personal Access Token.
 *
 * GITHUB_ORG
 *     GitHub organization login/name.
 *
 * GITHUB_ORG_ID
 *     Organization ID.
 *
 * GITHUB_TEAM_ID
 *     ID of the class Team that students should receive access to.
 *
 *
 * AUTOMATION TRIGGERS
 * -------------------
 * 1. onFormSubmit
 *    Event source: From spreadsheet
 *    Event type: On form submit
 *
 * 2. processPendingInvitations
 *    Event source: Time-driven
 *    Current recommended interval: Every 10 minutes
 * 
 * MANUAL RECOVERY
 * ---------------
 * If a legitimate invitation fails, an administrator can run 
 *    retryInvitationRow(rowNumber) 
 * from the Apps Script editor. 
 * The row must have a status of Error or Pending.
 *
 * IMPORTANT
 * ---------
 * Do not expose GITHUB_TOKEN in source code, logs, or spreadsheets.
 *
 * The GitHub token is intentionally stored in Script Properties.
 */


/* ============================================================================
   CONFIGURATION
   ========================================================================== */

const CONFIG = {
    INVITATION_SHEET: "GitHub Invitations",
    FORM_RESPONSE_SHEET: "Form Responses 1",

    // Maximum number of Pending rows processed during one queue run.
    MAX_PER_RUN: 20,

    // GitHub REST API version currently used by this project.
    GITHUB_API_VERSION: "2026-03-10"
};


/* ============================================================================
   GITHUB API HELPERS
   ========================================================================== */

/**
 * Return the GitHub user ID for a GitHub username.
 *
 * @param {string} username GitHub username.
 * @returns {number} GitHub user ID.
 *
 * @throws {Error} If the GitHub user cannot be found or the API request fails.
 */
function getGitHubUserId_(username) {
    const token = PropertiesService
        .getScriptProperties()
        .getProperty("GITHUB_TOKEN");

    if (!token) {
        throw new Error("GITHUB_TOKEN was not found in Script Properties.");
    }

    const url =
        `https://api.github.com/users/${encodeURIComponent(username)}`;

    const response = UrlFetchApp.fetch(url, {
        method: "get",
        headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": CONFIG.GITHUB_API_VERSION
        },
        muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();

    if (responseCode !== 200) {
        throw new Error(
            `GitHub user lookup failed: ${responseCode}`
        );
    }

    const user = JSON.parse(response.getContentText());

    return user.id;
}


/**
 * Check whether a GitHub user is already a member of the organization.
 *
 * GitHub returns:
 *     204 → user is a member
 *     404 → user is not a member
 *
 * @param {string} username GitHub username.
 * @returns {boolean} True if the user is already an organization member.
 *
 * @throws {Error} If GitHub returns an unexpected response.
 */
function checkOrganizationMembership_(username) {
    const props = PropertiesService.getScriptProperties();

    const token = props.getProperty("GITHUB_TOKEN");
    const org = props.getProperty("GITHUB_ORG");

    if (!token) {
        throw new Error("GITHUB_TOKEN was not found in Script Properties.");
    }

    if (!org) {
        throw new Error("GITHUB_ORG was not found in Script Properties.");
    }

    const url =
        `https://api.github.com/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`;

    const response = UrlFetchApp.fetch(url, {
        method: "get",
        headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": CONFIG.GITHUB_API_VERSION
        },
        muteHttpExceptions: true
    });

    const status = response.getResponseCode();

    if (status === 204) {
        return true;
    }

    if (status === 404) {
        return false;
    }

    throw new Error(
        `Organization membership check failed: HTTP ${status} - ${response.getContentText()}`
    );
}


/**
 * Determine whether an error should be retried during a later queue run.
 *
 * Retryable conditions:
 *     403 → possible rate-limit response
 *     429 → rate-limit response
 *     500 → GitHub/server error
 *     502 → gateway error
 *     503 → service unavailable
 *     504 → gateway timeout
 *
 * @param {Error} error Error thrown during processing.
 * @returns {boolean} True if the error should remain Pending.
 */
function isRetryableGitHubError_(error) {
    const message = error.message || "";

    if (
        message.includes("HTTP 403") ||
        message.includes("HTTP 429")
    ) {
        return true;
    }

    if (
        message.includes("HTTP 500") ||
        message.includes("HTTP 502") ||
        message.includes("HTTP 503") ||
        message.includes("HTTP 504")
    ) {
        return true;
    }

    return false;
}


/* ============================================================================
   CORE PROCESSING
   ========================================================================== */

/**
 * Process one student row from the GitHub Invitations sheet.
 *
 * Processing flow:
 *
 * 1. Validate GitHub username.
 * 2. Skip rows already marked Invited or Member.
 * 3. Look up GitHub user ID.
 * 4. Check organization membership.
 * 5. If already a member → Member.
 * 6. Otherwise send organization invitation with the class Team.
 * 7. If invitation succeeds → Invited.
 * 8. If a permanent error occurs → Error.
 * 9. If a retryable error occurs → leave as Pending.
 *
 * @param {number} rowNumber Spreadsheet row number to process.
 */
function processInvitationRow(rowNumber) {
    const sheet = SpreadsheetApp
        .getActiveSpreadsheet()
        .getSheetByName(CONFIG.INVITATION_SHEET);

    if (!sheet) {
        throw new Error(
            `Sheet "${CONFIG.INVITATION_SHEET}" was not found.`
        );
    }

    try {

        /* ------------------------------------------------------------------------
           1. Read the row
           ---------------------------------------------------------------------- */

        const row = sheet
            .getRange(rowNumber, 1, 1, 9)
            .getValues()[0];

        const [
            timestamp,
            fullName,
            githubUsername,
            email,
            status,
            githubUserId,
            invitationId,
            error,
            processedAt
        ] = row;


        /* ------------------------------------------------------------------------
           2. Basic validation
           ---------------------------------------------------------------------- */

        if (!githubUsername) {
            throw new Error("GitHub username is missing.");
        }


        /* ------------------------------------------------------------------------
           3. Skip completed rows
           ---------------------------------------------------------------------- */

        if (status === "Invited" || status === "Member") {
            Logger.log(
                `Skipping row ${rowNumber}: status is already "${status}".`
            );

            return;
        }


        /* ------------------------------------------------------------------------
           4. Look up GitHub user
           ---------------------------------------------------------------------- */

        const userId = getGitHubUserId_(githubUsername);

        // Store the GitHub user ID in column F.
        sheet.getRange(rowNumber, 6).setValue(userId);


        /* ------------------------------------------------------------------------
           5. Check organization membership
           ---------------------------------------------------------------------- */

        const isMember =
            checkOrganizationMembership_(githubUsername);

        if (isMember) {

            sheet.getRange(rowNumber, 5).setValue("Member");

            sheet.getRange(rowNumber, 8).clearContent();

            sheet.getRange(rowNumber, 9).setValue(new Date());

            Logger.log(
                `${githubUsername} is already an organization member.`
            );

            return;
        }


        /* ------------------------------------------------------------------------
           6. Read GitHub configuration
           ---------------------------------------------------------------------- */

        const props = PropertiesService.getScriptProperties();

        const token = props.getProperty("GITHUB_TOKEN");
        const org = props.getProperty("GITHUB_ORG");
        const teamId = props.getProperty("GITHUB_TEAM_ID");

        if (!token) {
            throw new Error(
                "GITHUB_TOKEN was not found in Script Properties."
            );
        }

        if (!org) {
            throw new Error(
                "GITHUB_ORG was not found in Script Properties."
            );
        }

        if (!teamId) {
            throw new Error(
                "GITHUB_TEAM_ID was not found in Script Properties."
            );
        }


        /* ------------------------------------------------------------------------
           7. Build invitation request
           ---------------------------------------------------------------------- */

        const url =
            `https://api.github.com/orgs/${encodeURIComponent(org)}/invitations`;

        const payload = {
            invitee_id: userId,
            role: "direct_member",
            team_ids: [Number(teamId)]
        };


        /* ------------------------------------------------------------------------
           8. Send invitation
           ---------------------------------------------------------------------- */

        const response = UrlFetchApp.fetch(url, {
            method: "post",

            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": CONFIG.GITHUB_API_VERSION
            },

            contentType: "application/json",

            payload: JSON.stringify(payload),

            muteHttpExceptions: true
        });

        const responseCode =
            response.getResponseCode();

        const responseBody =
            response.getContentText();

        Logger.log(
            "Invitation HTTP status: " + responseCode
        );


        /* ------------------------------------------------------------------------
           9. Handle invitation failure
           ---------------------------------------------------------------------- */

        if (responseCode !== 201) {
            throw new Error(
                `Invitation failed: HTTP ${responseCode}: ${responseBody}`
            );
        }


        /* ------------------------------------------------------------------------
           10. Record successful invitation
           ---------------------------------------------------------------------- */

        const invitation =
            JSON.parse(responseBody);

        sheet.getRange(rowNumber, 5).setValue("Invited");

        sheet.getRange(rowNumber, 7).setValue(invitation.id);

        sheet.getRange(rowNumber, 8).clearContent();

        sheet.getRange(rowNumber, 9).setValue(new Date());

        Logger.log(
            `${githubUsername} was successfully invited.`
        );

    } catch (error) {

        /* ------------------------------------------------------------------------
           Error handling
           ---------------------------------------------------------------------- */

        const retryable =
            isRetryableGitHubError_(error);

        if (retryable) {

            // Leave the row Pending so a future queue run can retry it.
            sheet.getRange(rowNumber, 5).setValue("Pending");

        } else {

            // Permanent error.
            sheet.getRange(rowNumber, 5).setValue("Error");
        }

        sheet.getRange(rowNumber, 8).setValue(error.message);

        sheet.getRange(rowNumber, 9).setValue(new Date());

        Logger.log(
            `Error processing row ${rowNumber}: ${error.message}`
        );

        // Re-throw so the queue processor can count the failure.
        throw error;
    }
}


/**
 * Process all Pending students, up to MAX_PER_RUN.
 *
 * This function is intended to be run automatically by a time-driven
 * Apps Script trigger.
 *
 * Example result:
 *
 *     Finished processing.
 *     Attempted: 20,
 *     Successful: 18,
 *     Errors: 2
 */
function processPendingInvitations() {
    const sheet = SpreadsheetApp
        .getActiveSpreadsheet()
        .getSheetByName(CONFIG.INVITATION_SHEET);

    if (!sheet) {
        throw new Error(
            `Sheet "${CONFIG.INVITATION_SHEET}" was not found.`
        );
    }

    const lastRow = sheet.getLastRow();

    if (lastRow < 2) {
        Logger.log("No student records found.");
        return;
    }

    const data = sheet
        .getRange(2, 1, lastRow - 1, 9)
        .getValues();

    let attemptedCount = 0;
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < data.length; i++) {

        if (attemptedCount >= CONFIG.MAX_PER_RUN) {
            Logger.log(
                `Batch limit of ${CONFIG.MAX_PER_RUN} reached.`
            );

            break;
        }

        const rowNumber = i + 2;

        // Column E = Status.
        const status = data[i][4];

        // Only Pending rows belong in the processing queue.
        if (status !== "Pending") {
            continue;
        }

        attemptedCount++;

        try {

            processInvitationRow(rowNumber);

            successCount++;

            Logger.log(
                `Row ${rowNumber} processed successfully.`
            );

        } catch (error) {

            errorCount++;

            Logger.log(
                `Error processing row ${rowNumber}: ${error.message}`
            );
        }
    }

    Logger.log(
        `Finished processing. ` +
        `Attempted: ${attemptedCount}, ` +
        `Successful: ${successCount}, ` +
        `Errors: ${errorCount}`
    );
}


/* ============================================================================
   FORM SUBMISSION AUTOMATION
   ========================================================================== */

/**
 * Installable spreadsheet form-submit trigger.
 *
 * This function receives the event object generated when a student submits
 * the Google Form.
 *
 * It copies the new submission into GitHub Invitations with status Pending.
 *
 * IMPORTANT:
 * This function does NOT contact GitHub.
 *
 * GitHub processing is deliberately handled separately by
 * processPendingInvitations().
 *
 * @param {Object} e Google Apps Script form-submit event object.
 */
function onFormSubmit(e) {

    if (!e || !e.range) {
        throw new Error(
            "onFormSubmit must be run by a spreadsheet form-submit trigger."
        );
    }

    const sourceSheet =
        e.range.getSheet();

    // Make sure the event came from the expected form-response sheet.
    if (
        sourceSheet.getName() !==
        CONFIG.FORM_RESPONSE_SHEET
    ) {
        Logger.log(
            `Ignoring submission from sheet "${sourceSheet.getName()}".`
        );

        return;
    }

    const rowNumber =
        e.range.getRow();

    const response =
        sourceSheet
        .getRange(rowNumber, 1, 1, 4)
        .getValues()[0];

    const [
        timestamp,
        fullName,
        githubUsername,
        email
    ] = response;


    /* --------------------------------------------------------------------------
       Validate required form fields
       ------------------------------------------------------------------------ */

    if (!fullName || !githubUsername) {

        Logger.log(
            `Skipping form row ${rowNumber}: required information is missing.`
        );

        return;
    }


    /* --------------------------------------------------------------------------
       Locate processing sheet
       ------------------------------------------------------------------------ */

    const spreadsheet =
        SpreadsheetApp.getActiveSpreadsheet();

    const invitationSheet =
        spreadsheet.getSheetByName(
            CONFIG.INVITATION_SHEET
        );

    if (!invitationSheet) {
        throw new Error(
            `Sheet "${CONFIG.INVITATION_SHEET}" was not found.`
        );
    }


    /* --------------------------------------------------------------------------
       Prevent duplicate imports
       ------------------------------------------------------------------------ */

    const lastInvitationRow =
        invitationSheet.getLastRow();

    if (lastInvitationRow >= 2) {

        const existingData =
            invitationSheet
            .getRange(
                2,
                1,
                lastInvitationRow - 1,
                4
            )
            .getValues();

        const alreadyImported =
            existingData.some(row => {

                const existingTimestamp = row[0];
                const existingUsername = row[2];

                return (
                    existingTimestamp instanceof Date &&
                    timestamp instanceof Date &&
                    existingTimestamp.getTime() ===
                    timestamp.getTime() &&
                    existingUsername === githubUsername
                );
            });

        if (alreadyImported) {

            Logger.log(
                `${githubUsername} has already been imported.`
            );

            return;
        }
    }


    /* --------------------------------------------------------------------------
       Add student to processing queue
       ------------------------------------------------------------------------ */

    invitationSheet.appendRow([
        timestamp,
        fullName,
        githubUsername,
        email,
        "Pending",
        "",
        "",
        "",
        ""
    ]);

    Logger.log(
        `Imported ${githubUsername} from form submission.`
    );
}


/* ============================================================================
   ADMINISTRATIVE / DIAGNOSTIC FUNCTIONS
   ========================================================================== */

/**
 * Test the GitHub authentication stored in Script Properties.
 *
 * This function does not modify GitHub.
 */
function testGitHubConnection() {
    const token = PropertiesService
        .getScriptProperties()
        .getProperty("GITHUB_TOKEN");

    if (!token) {
        throw new Error(
            "GITHUB_TOKEN was not found in Script Properties."
        );
    }

    const response = UrlFetchApp.fetch(
        "https://api.github.com/user", {
            method: "get",

            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": CONFIG.GITHUB_API_VERSION
            },

            muteHttpExceptions: true
        }
    );

    Logger.log(
        "HTTP status: " + response.getResponseCode()
    );

    Logger.log(
        response.getContentText()
    );
}


/**
 * List organizations accessible to the authenticated GitHub account.
 *
 * Administrative diagnostic function.
 */
function getMyOrganizations() {
    const token = PropertiesService
        .getScriptProperties()
        .getProperty("GITHUB_TOKEN");

    if (!token) {
        throw new Error(
            "GITHUB_TOKEN was not found in Script Properties."
        );
    }

    const response = UrlFetchApp.fetch(
        "https://api.github.com/user/orgs?per_page=100", {
            method: "get",

            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": CONFIG.GITHUB_API_VERSION
            },

            muteHttpExceptions: true
        }
    );

    Logger.log(
        "HTTP status: " + response.getResponseCode()
    );

    Logger.log(
        response.getContentText()
    );
}


/**
 * List teams in the configured organization.
 *
 * Administrative diagnostic function.
 */
function getMyTeams() {
    const props =
        PropertiesService.getScriptProperties();

    const token =
        props.getProperty("GITHUB_TOKEN");

    const org =
        props.getProperty("GITHUB_ORG");

    if (!token) {
        throw new Error(
            "GITHUB_TOKEN was not found in Script Properties."
        );
    }

    if (!org) {
        throw new Error(
            "GITHUB_ORG was not found in Script Properties."
        );
    }

    const url =
        `https://api.github.com/orgs/${encodeURIComponent(org)}/teams?per_page=100`;

    const response = UrlFetchApp.fetch(
        url, {
            method: "get",

            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": CONFIG.GITHUB_API_VERSION
            },

            muteHttpExceptions: true
        }
    );

    Logger.log(
        "HTTP status: " + response.getResponseCode()
    );

    Logger.log(
        response.getContentText()
    );
}


/**
 * Look up a GitHub username.
 *
 * Administrative diagnostic function.
 *
 * Change the username below when you need to test a specific account.
 */
function testFindGitHubUser() {
    const username = "ChidiebereMicah";

    const userId =
        getGitHubUserId_(username);

    Logger.log(
        `GitHub user ID for ${username}: ${userId}`
    );
}


/**
 * Check whether a GitHub user is already an organization member.
 *
 * Administrative diagnostic function.
 */
function testOrganizationMembership() {
    const username =
        "Nduka-Godstime-Oweniwe";

    const isMember =
        checkOrganizationMembership_(username);

    Logger.log(
        `${username} is already an organization member: ${isMember}`
    );
}


/**
 * Inspect a row in GitHub Invitations.
 *
 * This function only reads the spreadsheet.
 *
 * It does NOT contact GitHub and does NOT modify anything.
 *
 * Change the row number below when inspecting a specific student.
 */
function inspectInvitationRow(rowNumber) {
    const sheet =
        SpreadsheetApp
        .getActiveSpreadsheet()
        .getSheetByName(CONFIG.INVITATION_SHEET);

    if (!sheet) {
        throw new Error(
            `Sheet "${CONFIG.INVITATION_SHEET}" was not found.`
        );
    }

    const row =
        sheet
        .getRange(rowNumber, 1, 1, 9)
        .getValues()[0];

    const [
        timestamp,
        fullName,
        githubUsername,
        email,
        status,
        githubUserId,
        invitationId,
        error,
        processedAt
    ] = row;

    Logger.log("Timestamp: " + timestamp);
    Logger.log("Full Name: " + fullName);
    Logger.log("GitHub Username: " + githubUsername);
    Logger.log("Email: " + email);
    Logger.log("Status: " + status);
    Logger.log("GitHub User ID: " + githubUserId);
    Logger.log("Invitation ID: " + invitationId);
    Logger.log("Error: " + error);
    Logger.log("Processed At: " + processedAt);
}


/**
 * Convenience wrapper for inspecting row 2.
 *
 * Change the row number when needed, or call inspectInvitationRow()
 * directly from the Apps Script editor.
 */
function testInspectInvitationRow() {
    inspectInvitationRow(2);
}


/**
 * Manually retry a failed or pending GitHub invitation.
 *
 * ADMINISTRATIVE USE ONLY
 *
 * Use this function when a student legitimately failed to process
 * automatically and you want to retry that specific row immediately.
 *
 * Example:
 *   retryInvitationRow(17);
 *
 * The row must currently have Status = "Error" or "Pending".
 *
 * The function reuses the production invitation logic in
 * processInvitationRow(), so it performs the same GitHub user lookup,
 * membership check, invitation request, and status updates as the
 * normal queue processor.
 *
 * @param {number} rowNumber Row number in the "GitHub Invitations" sheet.
 * @throws {Error} If the row does not have status "Error" or "Pending".
 */
function retryInvitationRow(rowNumber) {
    const sheet = SpreadsheetApp
        .getActiveSpreadsheet()
        .getSheetByName(CONFIG.INVITATION_SHEET);

    const status = sheet.getRange(rowNumber, 5).getValue();

    if (status !== "Error" && status !== "Pending") {
        throw new Error(
            `Row ${rowNumber} has status "${status}" and cannot be manually retried.`
        );
    }

    processInvitationRow(rowNumber);
}