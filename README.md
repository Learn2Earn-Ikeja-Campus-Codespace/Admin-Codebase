# Admin-Codebase
This repo contains the following: 1. Scripts for automating GitHub organization sign up 2. Maintenance code


# Admin-Codebase

Administrative and automation code for managing the learning organization's GitHub infrastructure.

This repository contains scripts, configuration documentation, and maintenance utilities used to administer the organization's repositories, teams, student access, and related learning infrastructure.

## Purpose

The `Admin-Codebase` repository serves as the central codebase for administrative tooling used to support the learning organization.

Its primary goals are to:

* Automate repetitive administrative tasks.
* Manage student access to the organization's GitHub resources.
* Maintain automation used for GitHub organization invitations.
* Support team and repository administration.
* Provide a documented and version-controlled home for maintenance scripts.
* Make administrative processes reproducible and maintainable.

## Current Automation

### GitHub Student Enrollment

The current enrollment system connects:

```text
Google Form
     ↓
Google Sheets
     ↓
Google Apps Script
     ↓
GitHub API
     ↓
GitHub Organization
     ↓
Class Team
     ↓
Class Repositories
```

Students submit their GitHub username through the enrollment form.

The Apps Script then:

1. Receives the form submission.
2. Adds the student to the `GitHub Invitations` processing sheet.
3. Places the submission in `Pending` status.
4. Looks up the student's GitHub account.
5. Checks whether the student is already an organization member.
6. Sends a GitHub organization invitation when necessary.
7. Adds the student to the configured class team.
8. Records the invitation and GitHub user information.
9. Records errors for administrative review.
10. Automatically retries eligible pending records through the scheduled queue.

## Repository Structure

The repository may contain administrative code organized approximately as follows:

```text
Admin-Codebase/
│
├── github/
│   ├── organization/
│   ├── teams/
│   └── repositories/
│
├── enrollment/
│   └── google-apps-script/
│
├── maintenance/
│
├── documentation/
│
└── README.md
```

The exact structure may evolve as additional administrative systems are introduced.

## GitHub Enrollment Automation

The current Google Apps Script contains several major components.

### `onFormSubmit(e)`

Receives a new Google Form submission and adds the student to the processing queue.

New students initially receive:

```text
Status = Pending
```

### `processPendingInvitations()`

Processes pending enrollment records.

The function is intended to run through a time-driven Apps Script trigger.

The current system processes a limited number of records per run to avoid unnecessarily large API batches.

### `processInvitationRow(rowNumber)`

Handles the actual GitHub enrollment process for an individual student.

It:

* Validates the GitHub username.
* Retrieves the GitHub user ID.
* Checks organization membership.
* Sends the organization invitation when necessary.
* Adds the configured team to the invitation.
* Records the GitHub invitation ID.
* Updates the processing status.

### `retryInvitationRow(rowNumber)`

Administrative recovery function for legitimately failed or pending records.

Example:

```javascript
retryInvitationRow(17);
```

The function allows an administrator to retry a specific record without waiting for the scheduled queue.

### `inspectInvitationRow(rowNumber)`

Administrative diagnostic function for inspecting the current state of an enrollment record.

It does not modify GitHub or the spreadsheet.

## Enrollment Statuses

The `GitHub Invitations` sheet currently uses the following statuses:

| Status    | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| `Pending` | Student is waiting to be processed or is eligible for another retry. |
| `Invited` | GitHub organization invitation was successfully created.             |
| `Member`  | Student is already recognized as an organization member.             |
| `Error`   | Processing encountered a non-retryable error and requires review.    |

> **Note:** `Invited` currently represents a successfully sent invitation. It does not automatically change to `Member` when the student accepts the invitation. Membership synchronization may be added as a future feature.

## Required Configuration

Administrative automation may require credentials and configuration values such as:

```text
GITHUB_TOKEN
GITHUB_ORG
GITHUB_ORG_ID
GITHUB_TEAM_ID
```

These values must be stored securely in the appropriate secret/configuration mechanism.

For Google Apps Script, sensitive values are stored in **Script Properties** rather than in source code.

## Security

### Never commit secrets

Do **not** commit any of the following:

* GitHub Personal Access Tokens.
* GitHub private SSH keys.
* Google credentials.
* OAuth credentials.
* API keys.
* Passwords.
* Service-account private keys.
* Spreadsheet credentials.
* Other authentication secrets.

For example, this must never appear in source code:

```javascript
const token = "github_pat_xxxxxxxxxxxxxxxxx";
```

Instead, credentials should be retrieved from a secure configuration mechanism such as Apps Script Script Properties.

### Public repository considerations

If this repository is public, assume that everything committed to it can be viewed by anyone.

Administrative code should therefore be written with the assumption that:

> **Source code is public; credentials are private.**

Before pushing a change, check that no credentials, private keys, personal data, or other sensitive information are included.

## GitHub Permissions

Administrative repositories and scripts may require higher privileges than normal learning repositories.

Access should therefore be granted only to trusted administrators.

Student-facing repositories should remain separate from this administrative codebase.

A typical organization structure is:

```text
Organization
│
├── Admin-Codebase
│     └── Administrators
│
├── Class repositories
│     └── Student teams
│
└── Other learning repositories
      └── Appropriate teams
```

Students should not receive access to administrative repositories merely because they are members of a class team.

## Development and Change Management

Administrative code should be changed carefully because errors can affect many organization members at once.

Recommended workflow:

```text
Create branch
     ↓
Make change
     ↓
Test with controlled account/data
     ↓
Review
     ↓
Merge
     ↓
Deploy/update automation
```

Avoid testing destructive or organization-wide operations against real student records unless the operation has been verified independently.

## Testing

Administrative automation should provide separate diagnostic/test functions where appropriate.

Testing should preferably use:

* A controlled GitHub account.
* Test spreadsheet records.
* Clearly identifiable test usernames.
* Non-production repositories where possible.

Test functions that can create invitations, modify teams, or change repository permissions should be treated as potentially destructive administrative operations.

## Maintenance

When modifying administrative automation:

1. Read the existing documentation before changing behavior.
2. Preserve existing production functionality unless intentionally replacing it.
3. Update documentation when behavior changes.
4. Keep credentials outside the repository.
5. Test changes before deploying them.
6. Record significant architectural changes in Git history.
7. Remove obsolete experimental code once the production implementation has been verified.

## Future Improvements

Potential future additions include:

* Automatic synchronization of `Invited → Member` after invitation acceptance.
* Support for multiple class teams.
* Automated repository/team provisioning.
* More granular repository permissions.
* Administrative dashboards.
* Enrollment and membership reporting.
* Automated cleanup of inactive members.
* Improved API retry and rate-limit handling.
* Audit logging.
* Automated notifications to administrators.
* Branch protection and repository governance automation.

## Administrative Principle

This repository contains infrastructure that supports the learning organization.

The guiding principle is:

> **Automate repetitive administration while keeping access, credentials, and destructive operations under deliberate human control.**

Changes to this repository should therefore prioritize reliability, security, traceability, and maintainability.

