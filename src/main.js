import * as core from '@actions/core'
import {
  getRepoInfo,
  getDependabotAlerts,
  parseAlert,
  getAlertStatus
} from './github.js'
import {
  createJiraClient,
  createJiraIssue,
  syncJiraIssueStatus,
  findDependabotIssues,
  extractAllAlertUrlsFromIssue,
  extractGhsaIdFromIssue,
  extractAlertIdFromUrl,
  closeJiraIssue,
  appendAlertUrlToIssue,
  reopenJiraIssue
} from './jira.js'

/**
 * Get input configuration from action inputs
 * @returns {Object} Configuration object
 */
function getConfig() {
  const jiraUrl = core.getInput('jira-url', { required: true })
  const jiraUsername = core.getInput('jira-username', { required: true })
  const jiraApiToken = core.getInput('jira-api-token', { required: true })
  const jiraProjectKey = core.getInput('jira-project-key', { required: true })

  // Validate URL format
  try {
    new URL(jiraUrl)
  } catch {
    throw new Error(`Invalid Jira URL format: ${jiraUrl}`)
  }

  // Validate project key format (alphanumeric + underscore/dash only)
  if (!/^[A-Z0-9_-]+$/i.test(jiraProjectKey)) {
    throw new Error(
      `Invalid Jira project key format: ${jiraProjectKey}. Must be alphanumeric with underscores or dashes only.`
    )
  }

  // Validate severity threshold
  const severityThreshold = core.getInput('severity-threshold') || 'medium'
  const validSeverities = ['low', 'medium', 'high', 'critical']
  if (!validSeverities.includes(severityThreshold.toLowerCase())) {
    throw new Error(
      `Invalid severity threshold: ${severityThreshold}. Must be one of: ${validSeverities.join(', ')}`
    )
  }

  // Validate due days (must be positive integers)
  const dueDays = {
    critical: parseInt(core.getInput('critical-due-days') || '1', 10),
    high: parseInt(core.getInput('high-due-days') || '7', 10),
    medium: parseInt(core.getInput('medium-due-days') || '30', 10),
    low: parseInt(core.getInput('low-due-days') || '90', 10)
  }

  Object.entries(dueDays).forEach(([severity, days]) => {
    if (isNaN(days) || days < 1 || days > 3650) {
      // Max 10 years
      throw new Error(
        `Invalid ${severity}-due-days: ${days}. Must be a positive integer between 1 and 3650.`
      )
    }
  })

  return {
    jira: {
      url: jiraUrl,
      username: jiraUsername,
      apiToken: jiraApiToken,
      projectKey: jiraProjectKey,
      issueType: core.getInput('jira-issue-type') || 'Bug',
      priority: core.getInput('jira-priority') || 'Medium',
      labels: core.getInput('jira-labels') || 'dependabot,security',
      assignee: core.getInput('jira-assignee') || null,
      dueDays
    },
    filters: {
      severityThreshold: severityThreshold.toLowerCase(),
      excludeDismissed: core.getBooleanInput('exclude-dismissed') !== false
    },
    behavior: {
      updateExisting: core.getBooleanInput('update-existing') !== false,
      autoCloseResolved: core.getBooleanInput('auto-close-resolved') !== false,
      closeTransition: core.getInput('close-transition') || 'Done',
      closeComment:
        core.getInput('close-comment') ||
        'This issue has been automatically closed because the associated Dependabot alert was resolved.',
      // JBR note: 'Reopen' is dead code, but used by the unit tests to verify
      reopenTransition: core.getInput('reopen-transition') || 'Reopen',
      dryRun: core.getBooleanInput('dry-run') === true
    }
  }
}

/**
 * The main function for the action.
 *
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run() {
  try {
    const config = getConfig()

    core.info('Starting Dependabot Jira Sync...')

    if (config.behavior.dryRun) {
      core.warning('🧪 DRY RUN MODE - No changes will be made')
    }

    // Get repository information
    const { owner, repo } = getRepoInfo()
    core.info(`Repository: ${owner}/${repo}`)

    // Fetch Dependabot alerts
    const alerts = await getDependabotAlerts(owner, repo, {
      excludeDismissed: config.filters.excludeDismissed,
      severityThreshold: config.filters.severityThreshold
    })

    if (alerts.length === 0) {
      core.info('✅ No Dependabot alerts found matching the criteria')
      core.setOutput('issues-created', '0')
      core.setOutput('issues-updated', '0')
      core.setOutput('alerts-processed', '0')
      core.setOutput('summary', 'No alerts to process')
      return
    }

    // Create Jira client
    const jiraClient = createJiraClient(
      config.jira.url,
      config.jira.username,
      config.jira.apiToken
    )

    // Fetch all existing Dependabot issues once (more efficient than N individual queries)
    core.info(
      `Fetching existing Dependabot issues from Jira (project: ${config.jira.projectKey}, labels: ${config.jira.labels || '(none)'}, repo: ${owner}/${repo})...`
    )
    const existingIssues = await findDependabotIssues(
      jiraClient,
      config.jira.projectKey,
      config.jira.labels,
      false, // Get all issues (both open and resolved)
      owner, // Filter by current repository
      repo
    )
    core.info(`Found ${existingIssues.length} existing Dependabot issues`)

    // Log details about what we found for debugging
    if (existingIssues.length > 0) {
      core.debug('Existing issues:')
      for (const issue of existingIssues) {
        const urls = extractAllAlertUrlsFromIssue(issue)
        const ghsaId = extractGhsaIdFromIssue(issue)
        core.debug(
          `  ${issue.key}: ${urls.length} URL(s), GHSA: ${ghsaId || '(none)'}`
        )
      }
    }

    // Build lookup maps:
    // 1. alertUrl -> Jira issue (for matching by URL)
    // 2. ghsaId -> Jira issue (for GHSA-based grouping)
    // Note: All Dependabot alerts have a GHSA ID, so we only group by GHSA
    const issueMap = new Map()
    const ghsaMap = new Map()

    for (const issue of existingIssues) {
      // Extract ALL alert URLs from the issue and map each one
      const alertUrls = extractAllAlertUrlsFromIssue(issue)
      for (const alertUrl of alertUrls) {
        issueMap.set(alertUrl, issue)
        core.debug(`Mapped alert URL ${alertUrl} to Jira issue ${issue.key}`)
      }

      // Map by GHSA ID for grouping alerts with the same vulnerability
      const ghsaId = extractGhsaIdFromIssue(issue)
      if (ghsaId) {
        // GHSA might map to multiple issues, but we'll use the first one found
        if (!ghsaMap.has(ghsaId)) {
          ghsaMap.set(ghsaId, issue)
          core.debug(`Mapped GHSA ID ${ghsaId} to Jira issue ${issue.key}`)
        }
      }
    }

    core.info(
      `Built lookup maps: ${issueMap.size} URL mappings, ${ghsaMap.size} GHSA mappings from ${existingIssues.length} Jira issues`
    )

    // Log the maps for debugging duplicate issues
    if (issueMap.size > 0) {
      core.debug('URL → Issue mappings:')
      for (const [url, issue] of issueMap) {
        core.debug(`  ${url} → ${issue.key}`)
      }
    }
    if (ghsaMap.size > 0) {
      core.debug('GHSA → Issue mappings:')
      for (const [ghsaId, issue] of ghsaMap) {
        core.debug(`  ${ghsaId} → ${issue.key}`)
      }
    }

    let issuesCreated = 0
    let issuesUpdated = 0
    let issuesReopened = 0
    let alertsGroupedByGhsa = 0
    let processingErrors = 0
    const processedAlerts = []

    // Process each alert
    for (const alert of alerts) {
      try {
        const parsedAlert = parseAlert(alert)
        processedAlerts.push(parsedAlert)

        core.info(`Processing alert #${parsedAlert.id}: ${parsedAlert.title}`)
        core.debug(
          `  Alert URL: ${parsedAlert.url}, GHSA: ${parsedAlert.ghsaId || '(none)'}`
        )

        // Check if issue already exists using in-memory lookup by URL
        const existingIssue = issueMap.get(parsedAlert.url)
        if (existingIssue) {
          core.debug(`  ✓ Found existing issue by URL: ${existingIssue.key}`)
        } else {
          core.debug(`  ✗ No existing issue found by URL`)
        }

        if (existingIssue) {
          if (config.behavior.updateExisting) {
            core.info(`Found existing issue: ${existingIssue.key}`)
            const updateResult = await syncJiraIssueStatus(
              jiraClient,
              existingIssue.key,
              parsedAlert,
              config.behavior.dryRun,
              config.behavior.reopenTransition
            )

            // Only increment counter if we actually updated (not skipped due to no changes)
            if (updateResult.updated) {
              issuesUpdated++
            }

            if (updateResult.reopened) {
              issuesReopened++
            }
          } else {
            core.info(
              `Skipping existing issue: ${existingIssue.key} (update-existing is false)`
            )
          }
        } else {
          // Before creating a new issue, check if there's an existing issue for this GHSA
          // All Dependabot alerts have a GHSA ID, so we only need to check that
          let ghsaIssue = null
          if (parsedAlert.ghsaId) {
            core.debug(`  Checking GHSA map for: ${parsedAlert.ghsaId}`)
            ghsaIssue = ghsaMap.get(parsedAlert.ghsaId)
            if (ghsaIssue) {
              core.info(
                `  ✓ Found existing GHSA issue ${ghsaIssue.key} for ${parsedAlert.ghsaId} (in-memory lookup)`
              )
            } else {
              core.debug(
                `  ✗ No existing issue found for GHSA ${parsedAlert.ghsaId}`
              )
            }
          } else {
            core.debug(`  No GHSA ID for this alert, will create new issue`)
          }

          if (ghsaIssue) {
            // Found an existing issue for this GHSA - append the URL
            core.info(
              `Found existing GHSA issue ${ghsaIssue.key} for ${parsedAlert.ghsaId}. Appending alert URL.`
            )

            // Append the alert URL to the existing issue
            const appendResult = await appendAlertUrlToIssue(
              jiraClient,
              ghsaIssue.key,
              parsedAlert.url,
              config.behavior.dryRun
            )

            if (appendResult.updated) {
              alertsGroupedByGhsa++
            }

            // Sync the issue status and reopen if closed
            const updateResult = await syncJiraIssueStatus(
              jiraClient,
              ghsaIssue.key,
              parsedAlert,
              config.behavior.dryRun,
              config.behavior.reopenTransition
            )

            if (updateResult.reopened) {
              issuesReopened++
            }

            // Add this URL to the issueMap so future runs can find it by URL
            issueMap.set(parsedAlert.url, ghsaIssue)
            core.debug(
              `Added ${parsedAlert.url} to issueMap pointing to ${ghsaIssue.key}`
            )
          } else {
            // No existing issue for this GHSA - create new issue
            const newIssue = await createJiraIssue(
              jiraClient,
              config.jira,
              parsedAlert,
              config.behavior.dryRun
            )
            // If createJiraIssue threw an error, execution won't reach here
            // Only update our state if the issue was successfully created (or dry run succeeded)
            issuesCreated++

            core.info(
              `✅ Created Jira issue ${newIssue.key} for alert #${parsedAlert.id}`
            )

            // Add the new issue to our in-memory maps so subsequent alerts can find it
            // This happens for both dry runs and real runs to ensure grouping works correctly
            issueMap.set(parsedAlert.url, newIssue)
            if (parsedAlert.ghsaId) {
              if (!ghsaMap.has(parsedAlert.ghsaId)) {
                ghsaMap.set(parsedAlert.ghsaId, newIssue)
                core.debug(
                  `Added ${newIssue.key} to GHSA map for ${parsedAlert.ghsaId}`
                )
              }
            }
          }
        }
      } catch (error) {
        processingErrors++
        core.error(`Failed to process alert #${alert.number}: ${error.message}`)
        // Continue processing other alerts but mark the run as failed later
      }
    }

    if (processingErrors > 0) {
      throw new Error(
        `Failed to process ${processingErrors} alert(s); see logs for details`
      )
    }

    // Auto-close resolved issues if enabled
    let issuesClosed = 0
    if (config.behavior.autoCloseResolved) {
      core.info('\n🔄 Checking for resolved alerts to auto-close...')

      try {
        // Find only open Dependabot issues in Jira
        const openIssues = await findDependabotIssues(
          jiraClient,
          config.jira.projectKey,
          config.jira.labels,
          true, // Only fetch unresolved issues
          owner, // Filter by current repository
          repo
        )

        for (const issue of openIssues) {
          try {
            // Extract ALL alert URLs from the issue to check for cross-repo references
            const allAlertUrls = extractAllAlertUrlsFromIssue(issue)
            if (allAlertUrls.length === 0) {
              core.debug(
                `No Dependabot alert URLs found in issue ${issue.key}, skipping`
              )
              continue
            }

            // Check if there are URLs from other repositories
            const currentRepoPattern = `https://github.com/${owner}/${repo}/security/dependabot/`
            const currentRepoUrls = allAlertUrls.filter((url) =>
              url.startsWith(currentRepoPattern)
            )
            const otherRepoUrls = allAlertUrls.filter(
              (url) => !url.startsWith(currentRepoPattern)
            )

            if (otherRepoUrls.length > 0) {
              core.warning(
                `Issue ${issue.key} contains Dependabot URLs from other repositories: ${otherRepoUrls.join(', ')}. Skipping auto-close to avoid closing issues for other repos.`
              )
              continue
            }

            // Check status of ALL alerts from current repo
            const alertStatuses = []
            for (const alertUrl of currentRepoUrls) {
              const alertId = extractAlertIdFromUrl(alertUrl)
              if (!alertId) {
                core.warning(
                  `Could not extract alert ID from URL ${alertUrl} in issue ${issue.key}`
                )
                continue
              }

              const alertStatus = await getAlertStatus(owner, repo, alertId)
              alertStatuses.push({ alertId, alertUrl, status: alertStatus })
            }

            if (alertStatuses.length === 0) {
              core.warning(
                `No valid alert IDs found in issue ${issue.key}, skipping`
              )
              continue
            }

            // Check if ALL alerts are resolved
            const allResolved = alertStatuses.every(
              (a) =>
                a.status === 'fixed' ||
                a.status === 'dismissed' ||
                a.status === 'not_found'
            )

            // Check if ANY alerts are still open
            const anyOpen = alertStatuses.some((a) => a.status === 'open')

            // Check if issue is currently closed
            // In Jira, if resolution is not null/empty, the issue is closed/resolved
            // This works across all Jira workflows regardless of status names
            const isClosed = issue.fields?.resolution != null

            // Determine action based on issue state and alert statuses
            if (allResolved && !isClosed) {
              // All alerts resolved and issue is open -> Close it
              const resolvedCount = alertStatuses.length
              const closeComment = `${config.behavior.closeComment}\n\nAll ${resolvedCount} associated Dependabot alert(s) for this repository have been resolved.`

              await closeJiraIssue(
                jiraClient,
                issue.key,
                config.behavior.closeTransition,
                closeComment,
                config.behavior.dryRun
              )

              issuesClosed++

              if (!config.behavior.dryRun) {
                core.info(
                  `🔒 Closed Jira issue ${issue.key} (all ${resolvedCount} alerts resolved)`
                )
              }
            } else if (anyOpen && isClosed) {
              // Some alerts still open but issue is closed -> Reopen it
              const openAlerts = alertStatuses.filter(
                (a) => a.status === 'open'
              )
              const openAlertIds = openAlerts
                .map((a) => `#${a.alertId}`)
                .join(', ')

              const reopenComment = `Reopening issue because it still has open Dependabot alerts for this repository: ${openAlertIds}`

              const reopenResult = await reopenJiraIssue(
                jiraClient,
                issue.key,
                config.behavior.reopenTransition,
                reopenComment,
                config.behavior.dryRun
              )

              if (reopenResult.reopened) {
                issuesReopened++

                if (!config.behavior.dryRun) {
                  core.info(
                    `🔓 Reopened Jira issue ${issue.key} (${openAlerts.length} alert(s) still open)`
                  )
                }
              }
            } else if (!allResolved && !isClosed) {
              // Some alerts unresolved and issue is open -> Keep open
              const openCount = alertStatuses.filter(
                (a) => a.status === 'open'
              ).length
              core.debug(
                `Issue ${issue.key} has ${openCount} open alert(s), keeping open`
              )
            } else if (allResolved && isClosed) {
              // All resolved and already closed -> No action needed
              core.debug(
                `Issue ${issue.key} is already closed and all alerts resolved`
              )
            }
          } catch (error) {
            core.warning(
              `Failed to process issue ${issue.key} for auto-close: ${error.message}`
            )
            // Continue with other issues
          }
        }

        core.info(
          `Processed ${openIssues.length} open Dependabot issues for auto-close`
        )
      } catch (error) {
        core.warning(`Auto-close phase failed: ${error.message}`)
        // Don't fail the entire action for auto-close issues
      }
    } else {
      core.info('Auto-close feature is disabled')
    }

    // Generate summary
    const summary = config.behavior.dryRun
      ? `DRY RUN: Would create ${issuesCreated} issues, update ${issuesUpdated} issues, group ${alertsGroupedByGhsa} alerts by GHSA, reopen ${issuesReopened} issues, and close ${issuesClosed} issues`
      : `Created ${issuesCreated} new issues, updated ${issuesUpdated} existing issues, grouped ${alertsGroupedByGhsa} alerts by GHSA, reopened ${issuesReopened} closed issues, and closed ${issuesClosed} resolved issues`

    core.info(`\n📊 Summary:`)
    core.info(`- Alerts processed: ${processedAlerts.length}`)
    core.info(`- Issues created: ${issuesCreated}`)
    core.info(`- Issues updated: ${issuesUpdated}`)
    core.info(`- Alerts grouped by GHSA: ${alertsGroupedByGhsa}`)
    core.info(`- Issues reopened: ${issuesReopened}`)
    core.info(`- Issues closed: ${issuesClosed}`)

    if (config.behavior.dryRun) {
      core.info(`- Mode: DRY RUN (no actual changes made)`)
    }

    // Set outputs
    core.setOutput('issues-created', issuesCreated.toString())
    core.setOutput('issues-updated', issuesUpdated.toString())
    core.setOutput('alerts-grouped-by-ghsa', alertsGroupedByGhsa.toString())
    core.setOutput('issues-reopened', issuesReopened.toString())
    core.setOutput('issues-closed', issuesClosed.toString())
    core.setOutput('alerts-processed', processedAlerts.length.toString())
    core.setOutput('summary', summary)

    core.info('✅ Dependabot Jira Sync completed successfully')
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed('An unknown error occurred')
    }
  }
}
