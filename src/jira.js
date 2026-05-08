import * as core from '@actions/core'
import axios from 'axios'

/**
 * Sanitize input for use in JQL queries to prevent injection
 * @param {string} input - User input to sanitize
 * @returns {string} Sanitized input safe for JQL
 */
function sanitizeForJQL(input) {
  if (!input || typeof input !== 'string') {
    return ''
  }
  // Remove or escape characters that could be used for JQL injection
  return input.replace(/['"\\]/g, '').trim()
}

/**
 * Validate project key format (alphanumeric + underscore/dash only)
 * @param {string} projectKey - Project key to validate
 * @returns {boolean} True if valid
 */
function validateProjectKey(projectKey) {
  return /^[A-Z0-9_-]+$/i.test(projectKey)
}

/**
 * Create a Jira API client
 * @param {string} jiraUrl - Jira instance URL
 * @param {string} username - Jira username
 * @param {string} apiToken - Jira API token
 * @returns {Object} Axios instance configured for Jira API
 */
export function createJiraClient(jiraUrl, username, apiToken) {
  // Validate inputs
  if (!jiraUrl || !username || !apiToken) {
    throw new Error('Jira URL, username, and API token are required')
  }

  // Validate URL format
  try {
    new URL(jiraUrl)
  } catch {
    throw new Error('Invalid Jira URL format')
  }

  const client = axios.create({
    baseURL: `${jiraUrl}/rest/api/3`,
    auth: {
      username,
      password: apiToken
    },
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }
  })

  // Add response interceptor for error handling
  client.interceptors.response.use(
    (response) => response,
    (error) => {
      const status = error.response?.status
      const statusText = error.response?.statusText
      const errorMessages = error.response?.data?.errorMessages?.join(', ')
      const message = error.response?.data?.message
      const errors = error.response?.data?.errors

      let errorDetails = `Status: ${status} ${statusText}`
      if (errorMessages) errorDetails += ` | Error Messages: ${errorMessages}`
      if (message) errorDetails += ` | Message: ${message}`
      if (errors) errorDetails += ` | Errors: ${JSON.stringify(errors)}`
      if (error.response?.data)
        errorDetails += ` | Response: ${JSON.stringify(error.response.data)}`

      core.error(`Jira API Error: ${errorDetails}`)
      throw new Error(`Jira API Error: ${errorDetails}`)
    }
  )

  return client
}

const SEVERITY_TO_PRIORITY = {
  critical: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low'
}

/**
 * Resolve the Jira priority for an alert.
 * When set to "auto", maps Dependabot severity to Jira priority.
 * Any other value is returned as-is (static priority).
 * @param {string} prioritySetting - The jira-priority input value
 * @param {string} severity - Dependabot alert severity (critical, high, medium, low)
 * @returns {string|null} Resolved Jira priority name, or null if it cannot be determined
 */
export function resolvePriority(prioritySetting, severity) {
  if (prioritySetting?.toLowerCase() !== 'auto') {
    return prioritySetting || null
  }
  return SEVERITY_TO_PRIORITY[severity?.toLowerCase()] ?? null
}

/**
 * Calculate due date based on severity and alert creation date
 * @param {string} severity - Alert severity (critical, high, medium, low)
 * @param {Object} dueDaysConfig - Due days configuration
 * @param {string} createdAt - Alert creation timestamp (ISO string)
 * @returns {string} Due date in YYYY-MM-DD format
 */
export function calculateDueDate(severity, dueDaysConfig, createdAt) {
  const daysMap = {
    critical: dueDaysConfig.critical || 1,
    high: dueDaysConfig.high || 7,
    medium: dueDaysConfig.medium || 30,
    low: dueDaysConfig.low || 90
  }

  const days = daysMap[severity] || daysMap.medium
  const baseDate = createdAt ? new Date(createdAt) : new Date()
  const dueDate = new Date(baseDate)
  dueDate.setDate(dueDate.getDate() + days)

  return dueDate.toISOString().split('T')[0] // Return YYYY-MM-DD format
}

/**
 * Create a new Jira issue for a Dependabot alert
 * @param {Object} jiraClient - Jira API client
 * @param {Object} config - Jira configuration
 * @param {Object} alert - Parsed Dependabot alert
 * @param {boolean} dryRun - Whether this is a dry run
 * @returns {Promise<Object>} Created issue data
 */
export async function createJiraIssue(
  jiraClient,
  config,
  alert,
  dryRun = false
) {
  const { projectKey, issueType, priority, labels, assignee } = config

  const dueDate = calculateDueDate(
    alert.severity,
    config.dueDays,
    alert.createdAt
  )

  const description = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'heading',
        attrs: {
          level: 2
        },
        content: [
          {
            type: 'text',
            text: `Dependabot Security Alert #${alert.id}`
          }
        ]
      },
      {
        type: 'paragraph',
        content: []
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Package: ',
            marks: [{ type: 'strong' }]
          },
          {
            type: 'text',
            text: alert.package
          }
        ]
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Ecosystem: ',
            marks: [{ type: 'strong' }]
          },
          {
            type: 'text',
            text: alert.ecosystem
          }
        ]
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Severity: ',
            marks: [{ type: 'strong' }]
          },
          {
            type: 'text',
            text: alert.severity.toUpperCase()
          }
        ]
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Vulnerable Version Range: ',
            marks: [{ type: 'strong' }]
          },
          {
            type: 'text',
            text: alert.vulnerableVersionRange || 'Not available'
          }
        ]
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'First Patched Version: ',
            marks: [{ type: 'strong' }]
          },
          {
            type: 'text',
            text: alert.firstPatchedVersion || 'Not available'
          }
        ]
      },
      {
        type: 'paragraph',
        content: []
      },
      {
        type: 'heading',
        attrs: {
          level: 3
        },
        content: [
          {
            type: 'text',
            text: 'Description'
          }
        ]
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: alert.description
          }
        ]
      },
      ...(alert.cvss
        ? [
            {
              type: 'paragraph',
              content: []
            },
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'CVSS Score: ',
                  marks: [{ type: 'strong' }]
                },
                {
                  type: 'text',
                  text: alert.cvss.toString()
                }
              ]
            }
          ]
        : []),
      ...(alert.cveId
        ? [
            {
              type: 'paragraph',
              content: []
            },
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'CVE ID: ',
                  marks: [{ type: 'strong' }]
                },
                {
                  type: 'text',
                  text: alert.cveId
                }
              ]
            }
          ]
        : []),
      ...(alert.ghsaId
        ? [
            {
              type: 'paragraph',
              content: []
            },
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'GHSA ID: ',
                  marks: [{ type: 'strong' }]
                },
                {
                  type: 'text',
                  text: alert.ghsaId
                }
              ]
            }
          ]
        : []),
      {
        type: 'paragraph',
        content: []
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'GitHub Alert URL: ',
            marks: [{ type: 'strong' }]
          },
          {
            type: 'text',
            text: alert.url,
            marks: [
              {
                type: 'link',
                attrs: {
                  href: alert.url
                }
              }
            ]
          }
        ]
      },
      {
        type: 'paragraph',
        content: []
      },
      {
        type: 'rule'
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'This issue was automatically created by the Dependabot Jira Sync action.',
            marks: [{ type: 'em' }]
          }
        ]
      }
    ]
  }

  const issueData = {
    fields: {
      project: { key: projectKey },
      summary: `Dependabot Alert #${alert.id}: ${alert.title}`,
      description,
      issuetype: { name: issueType },
      duedate: dueDate
    }
  }

  // Priority is optional - only include if provided (some next-gen projects don't support it)
  const resolvedPriority = resolvePriority(priority, alert.severity)
  if (resolvedPriority) {
    issueData.fields.priority = { name: resolvedPriority }
  }

  // Add labels if provided
  if (labels && labels.length > 0) {
    issueData.fields.labels = labels.split(',').map((label) => label.trim())
  }

  // Add assignee if provided
  if (assignee) {
    issueData.fields.assignee = { name: assignee }
  }

  if (dryRun) {
    core.info(`[DRY RUN] Would create Jira issue: ${issueData.fields.summary}`)
    return { key: 'DRY-RUN-KEY', dryRun: true }
  }

  try {
    core.debug(
      `Creating Jira issue with payload: ${JSON.stringify(issueData, null, 2)}`
    )
    const response = await jiraClient.post('/issue', issueData)
    core.info(`Created Jira issue: ${response.data.key}`)
    return response.data
  } catch (error) {
    core.error(`Failed to create Jira issue: ${error.message}`)
    throw error
  }
}

/**
 * Update an existing Jira issue for a Dependabot alert
 * @param {Object} jiraClient - Jira API client
 * @param {string} issueKey - Jira issue key
 * @param {Object} alert - Parsed Dependabot alert
 * @param {boolean} dryRun - Whether this is a dry run
 * @returns {Promise<Object>} Update result
 */
export async function updateJiraIssue(
  jiraClient,
  issueKey,
  alert,
  dryRun = false,
  customComment = null
) {
  // If a custom comment is provided, use it (convert plain text to ADF if needed)
  // Otherwise, build the default alert-based comment
  const comment = customComment
    ? {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: customComment
              }
            ]
          }
        ]
      }
    : {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'heading',
            attrs: {
              level: 3
            },
            content: [
              {
                type: 'text',
                text: 'Dependabot Alert Updated'
              }
            ]
          },
          {
            type: 'paragraph',
            content: []
          },
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: `The Dependabot alert #${alert.id} has been updated.`
              }
            ]
          },
          {
            type: 'paragraph',
            content: []
          },
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Current Status: ',
                marks: [{ type: 'strong' }]
              },
              {
                type: 'text',
                text: alert.state
              }
            ]
          },
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Last Updated: ',
                marks: [{ type: 'strong' }]
              },
              {
                type: 'text',
                text: new Date(alert.updatedAt).toLocaleString()
              }
            ]
          },
          ...(alert.dismissedAt
            ? [
                {
                  type: 'paragraph',
                  content: []
                },
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'Dismissed At: ',
                      marks: [{ type: 'strong' }]
                    },
                    {
                      type: 'text',
                      text: new Date(alert.dismissedAt).toLocaleString()
                    }
                  ]
                }
              ]
            : []),
          ...(alert.dismissedReason
            ? [
                {
                  type: 'paragraph',
                  content: []
                },
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'Dismissed Reason: ',
                      marks: [{ type: 'strong' }]
                    },
                    {
                      type: 'text',
                      text: alert.dismissedReason
                    }
                  ]
                }
              ]
            : []),
          ...(alert.dismissedComment
            ? [
                {
                  type: 'paragraph',
                  content: []
                },
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'Dismissed Comment: ',
                      marks: [{ type: 'strong' }]
                    },
                    {
                      type: 'text',
                      text: alert.dismissedComment
                    }
                  ]
                }
              ]
            : []),
          {
            type: 'paragraph',
            content: []
          },
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'GitHub Alert URL: ',
                marks: [{ type: 'strong' }]
              },
              {
                type: 'text',
                text: alert.url,
                marks: [
                  {
                    type: 'link',
                    attrs: {
                      href: alert.url
                    }
                  }
                ]
              }
            ]
          }
        ]
      }

  if (dryRun) {
    core.info(`[DRY RUN] Would update Jira issue ${issueKey} with comment`)
    return { updated: true, dryRun: true }
  }

  try {
    await jiraClient.post(`/issue/${issueKey}/comment`, {
      body: comment
    })

    core.info(`Updated Jira issue: ${issueKey}`)
    return { updated: true }
  } catch (error) {
    core.error(`Failed to update Jira issue ${issueKey}: ${error.message}`)
    throw error
  }
}

/**
 * Find all Dependabot issues in a Jira project (both open and resolved)
 * @param {Object} jiraClient - Axios instance for Jira API
 * @param {string} projectKey - Jira project key
 * @param {string} labels - Comma-separated list of labels (e.g., "dependabot,security")
 * @param {boolean} onlyOpen - If true, only return unresolved issues (default: false)
 * @param {string} owner - GitHub repository owner (optional, for filtering by repo)
 * @param {string} repo - GitHub repository name (optional, for filtering by repo)
 * @returns {Promise<Array>} Array of Dependabot issues
 */
export async function findDependabotIssues(
  jiraClient,
  projectKey,
  labels,
  onlyOpen = false,
  owner = null,
  repo = null
) {
  // Validate inputs
  if (!validateProjectKey(projectKey)) {
    throw new Error(`Invalid project key format: ${projectKey}`)
  }

  const sanitizedProjectKey = sanitizeForJQL(projectKey)

  // Build label filter from configured labels
  // Parse comma-separated labels and create JQL conditions
  const labelArray = labels
    ? labels
        .split(',')
        .map((label) => label.trim())
        .filter((label) => label.length > 0)
    : []

  // Build JQL query with label conditions
  // Use AND to match issues that have all configured labels
  let jql = `project = "${sanitizedProjectKey}"`

  if (labelArray.length > 0) {
    const labelConditions = labelArray
      .map((label) => `labels = "${sanitizeForJQL(label)}"`)
      .join(' AND ')
    jql += ` AND ${labelConditions}`
  }

  // Filter by repository URL pattern to only get issues for this specific repo
  // This prevents matching issues from other repositories
  if (owner && repo) {
    const repoUrlPattern = `https://github.com/${sanitizeForJQL(owner)}/${sanitizeForJQL(repo)}/security/dependabot/`
    jql += ` AND description ~ "${repoUrlPattern}"`
    core.debug(`Filtering to repository: ${owner}/${repo}`)
  }

  // Optionally filter to only unresolved issues
  // "resolution IS EMPTY" finds issues that are not resolved/closed/done
  // This works across different Jira workflows regardless of status names
  if (onlyOpen) {
    jql += ' AND resolution IS EMPTY'
  }

  const scopeMsg = onlyOpen ? 'open' : 'all'
  const repoMsg = owner && repo ? ` for ${owner}/${repo}` : ''
  core.info(
    `Searching for ${scopeMsg} Dependabot issues in project ${projectKey}${repoMsg}`
  )
  core.debug(`Using JQL: ${jql}`)

  try {
    // Pagination: Jira returns results in pages
    // We need to fetch all pages to get all issues
    let allIssues = []
    let startAt = 0
    const maxResults = 100
    let total = 0

    do {
      core.debug(
        `Fetching issues: startAt=${startAt}, maxResults=${maxResults}`
      )

      const response = await jiraClient.get('/search/jql', {
        params: {
          jql,
          fields: 'key,summary,description,status',
          startAt,
          maxResults
        }
      })

      const issues = response.data.issues || []
      total = response.data.total || 0

      allIssues = allIssues.concat(issues)
      startAt += issues.length

      core.debug(
        `Retrieved ${issues.length} issues (${allIssues.length} of ${total} total)`
      )

      // Continue if there are more issues to fetch
    } while (startAt < total)

    core.info(`Found ${allIssues.length} ${scopeMsg} Dependabot issues${repoMsg}`)
    return allIssues
  } catch (error) {
    // Surface API errors so the workflow fails rather than silently skipping
    core.error(`Failed to search for Dependabot issues: ${error.message}`)
    throw error
  }
}

/**
 * Extract GitHub alert URL from Jira issue description
 * @param {Object} issue - Jira issue object
 * @returns {string|null} GitHub alert URL or null if not found
 */
export function extractAlertUrlFromIssue(issue) {
  // Debug: Log the issue structure
  core.debug(
    `Debug: Issue ${issue.key} structure: ${JSON.stringify(issue, null, 2)}`
  )

  // Jira API often nests fields under 'fields' object
  const description = issue.description || issue.fields?.description

  if (!description) {
    core.warning(`Could not extract GitHub alert URL from issue ${issue.key}`)
    return null
  }

  // Extract the GitHub alert URL from the description (ADF format)
  // Pattern: https://github.com/{owner}/{repo}/security/dependabot/{number}
  const descriptionStr = JSON.stringify(description)
  const urlMatch = descriptionStr.match(
    /https:\/\/github\.com\/[^/]+\/[^/]+\/security\/dependabot\/\d+/
  )

  if (urlMatch) {
    core.debug(
      `Extracted alert URL ${urlMatch[0]} from description of ${issue.key}`
    )
    return urlMatch[0]
  }

  core.warning(`Could not extract GitHub alert URL from issue ${issue.key}`)
  return null
}

/**
 * Extract alert ID from a GitHub Dependabot URL
 * @param {string} url - GitHub alert URL (e.g., https://github.com/owner/repo/security/dependabot/42)
 * @returns {string|null} Alert ID or null if cannot be extracted
 */
export function extractAlertIdFromUrl(url) {
  if (!url) return null

  // Extract the number from the URL path
  const match = url.match(/\/security\/dependabot\/(\d+)/)
  return match ? match[1] : null
}

/**
 * Close a Jira issue with a transition
 * @param {Object} jiraClient - Axios instance for Jira API
 * @param {string} issueKey - Jira issue key
 * @param {string} transition - Transition name (e.g., "Done")
 * @param {string} comment - Comment to add when closing
 * @param {boolean} dryRun - Whether this is a dry run
 * @returns {Promise<Object>} Result of the operation
 */
export async function closeJiraIssue(
  jiraClient,
  issueKey,
  transition,
  comment,
  dryRun = false
) {
  if (dryRun) {
    core.info(
      `[DRY RUN] Would close Jira issue ${issueKey} with transition "${transition}"`
    )
    return { closed: false, dryRun: true }
  }

  try {
    // First, get available transitions for the issue
    const transitionsResponse = await jiraClient.get(
      `/issue/${issueKey}/transitions`
    )
    const availableTransitions = transitionsResponse.data.transitions || []

    // Find the transition by name (case-insensitive)
    const targetTransition = availableTransitions.find(
      (t) => t.name.toLowerCase() === transition.toLowerCase()
    )

    if (!targetTransition) {
      const availableNames = availableTransitions.map((t) => t.name).join(', ')
      throw new Error(
        `Transition "${transition}" not available. Available transitions: ${availableNames}`
      )
    }

    // Add comment first
    if (comment) {
      await jiraClient.post(`/issue/${issueKey}/comment`, {
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: comment
                }
              ]
            }
          ]
        }
      })
    }

    // Perform the transition
    await jiraClient.post(`/issue/${issueKey}/transitions`, {
      transition: {
        id: targetTransition.id
      }
    })

    core.info(`Closed Jira issue: ${issueKey} using transition "${transition}"`)
    return { closed: true }
  } catch (error) {
    core.error(`Failed to close Jira issue ${issueKey}: ${error.message}`)
    throw error
  }
}
