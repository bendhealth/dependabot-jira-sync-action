import * as core from '@actions/core'
import axios from 'axios'

/**
 * Escape input for use in JQL queries to prevent injection
 * This escapes special JQL characters according to Atlassian documentation
 * @param {string} input - User input to escape
 * @returns {string} Escaped input safe for JQL
 */
function escapeForJQL(input) {
  if (!input || typeof input !== 'string') {
    return ''
  }
  // Escape special JQL characters: quotes, backslashes, and other operators
  // According to Jira JQL documentation, we need to escape quotes and backslashes
  // Also remove control characters and newlines that could break JQL syntax
  return input
    .replace(/\\/g, '\\\\') // Escape backslashes first
    .replace(/"/g, '\\"') // Escape double quotes
    .replace(/'/g, "\\'") // Escape single quotes
    .replace(/[\n\r\t]/g, ' ') // Replace newlines/tabs with spaces
    .trim()
}

/**
 * Validate that a string is safe for use in JQL (alphanumeric, dash, underscore only)
 * Use this for project keys and other structured fields
 * @param {string} input - Input to validate
 * @returns {string} Validated input
 * @throws {Error} If input contains unsafe characters
 */
function validateJQLSafeString(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Input must be a non-empty string')
  }
  // Only allow alphanumeric, dash, and underscore (safe for project keys, etc.)
  if (!/^[A-Z0-9_-]+$/i.test(input)) {
    throw new Error(
      `Input contains unsafe characters: ${input}. Only alphanumeric, dash, and underscore allowed.`
    )
  }
  return input
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
 * Sanitize text for safe use in Jira ADF (Atlassian Document Format)
 * Removes potentially dangerous content and limits length
 * @param {string} text - Text to sanitize
 * @param {number} maxLength - Maximum allowed length (default 5000)
 * @returns {string} Sanitized text
 */
function sanitizeADFText(text, maxLength = 5000) {
  if (!text || typeof text !== 'string') {
    return ''
  }

  // Remove control characters except newlines and tabs
  let sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')

  // Remove any HTML/script tags or event handlers (defense in depth)
  // Remove complete script tags
  sanitized = sanitized.replace(/<script[^>]*>.*?<\/script>/gi, '')
  // Remove any remaining opening or closing script tags
  sanitized = sanitized.replace(/<\/?script[^>]*>/gi, '')
  // Remove other dangerous tags
  sanitized = sanitized.replace(/<\/?iframe[^>]*>/gi, '')
  sanitized = sanitized.replace(/<\/?object[^>]*>/gi, '')
  sanitized = sanitized.replace(/<\/?embed[^>]*>/gi, '')
  // Remove event handlers
  sanitized = sanitized.replace(/on\w+\s*=/gi, '')

  // Limit length to prevent DoS
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + '... (truncated)'
  }

  return sanitized.trim()
}

/**
 * Validate and sanitize an alert ID (must be positive integer)
 * @param {number|string} alertId - Alert ID to validate
 * @returns {string} Validated alert ID as string
 * @throws {Error} If alert ID is invalid
 */
function validateAlertId(alertId) {
  const id = parseInt(alertId, 10)
  if (isNaN(id) || id < 1) {
    throw new Error(`Invalid alert ID: ${alertId}. Must be a positive integer.`)
  }
  return id.toString()
}

/**
 * Validate and sanitize URL
 * @param {string} url - URL to validate
 * @returns {string} Validated URL
 * @throws {Error} If URL is invalid
 */
function validateUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('URL must be a non-empty string')
  }

  try {
    const parsed = new URL(url)
    // Only allow https URLs from github.com
    if (parsed.protocol !== 'https:') {
      throw new Error('URL must use HTTPS protocol')
    }
    if (!parsed.hostname.endsWith('github.com')) {
      throw new Error('URL must be from github.com domain')
    }
    return parsed.href
  } catch (error) {
    throw new Error(`Invalid URL: ${url}. ${error.message}`)
  }
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
    },
    timeout: 30000 // 30 second timeout (Item 18)
  })

  // Add request interceptor for retry logic with exponential backoff (Item 10)
  client.interceptors.request.use(async (config) => {
    // Track retry state in the config
    config.metadata = config.metadata || {}
    config.metadata.retryCount = config.metadata.retryCount || 0
    return config
  })

  // Add response interceptor for error handling and retry logic
  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config || {}
      const status = error.response?.status
      const statusText = error.response?.statusText
      const errorMessages = error.response?.data?.errorMessages?.join(', ')
      const message = error.response?.data?.message
      const errors = error.response?.data?.errors

      // Retry logic for rate limiting and transient errors (Item 10)
      const maxRetries = 3
      const retryableStatuses = [429, 503, 502, 504] // Rate limit, service unavailable, bad gateway, gateway timeout
      const retryCount = (config.metadata && config.metadata.retryCount) || 0

      if (retryableStatuses.includes(status) && retryCount < maxRetries) {
        config.metadata.retryCount = retryCount + 1

        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.pow(2, retryCount) * 1000

        // Check for Retry-After header (used by rate limiting)
        const retryAfter = error.response?.headers['retry-after']
        const actualDelay = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay

        core.warning(
          `Jira API returned ${status}, retrying in ${actualDelay}ms (attempt ${retryCount + 1}/${maxRetries})`
        )

        await new Promise((resolve) => setTimeout(resolve, actualDelay))
        return client.request(config)
      }

      // Sanitize error details - avoid exposing full response which may contain sensitive data
      let errorDetails = `Status: ${status} ${statusText}`
      if (errorMessages) {
        // Truncate long error messages to prevent log flooding
        const truncated =
          errorMessages.length > 500
            ? errorMessages.substring(0, 500) + '...'
            : errorMessages
        errorDetails += ` | Error Messages: ${truncated}`
      }
      if (message) {
        // Truncate long messages
        const truncated =
          message.length > 200 ? message.substring(0, 200) + '...' : message
        errorDetails += ` | Message: ${truncated}`
      }
      if (errors) {
        // Only include field names, not values (values might be sensitive)
        const fieldNames = Object.keys(errors).join(', ')
        errorDetails += ` | Error Fields: ${fieldNames}`
      }

      // Do NOT log full response data as it may contain sensitive information
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

  // Validate and sanitize alert data from external API
  const sanitizedAlert = {
    id: validateAlertId(alert.id),
    title: sanitizeADFText(alert.title, 200),
    package: sanitizeADFText(alert.package, 200),
    ecosystem: sanitizeADFText(alert.ecosystem, 100),
    severity: sanitizeADFText(alert.severity, 50),
    vulnerableVersionRange: sanitizeADFText(alert.vulnerableVersionRange, 200),
    firstPatchedVersion: sanitizeADFText(alert.firstPatchedVersion, 100),
    description: sanitizeADFText(alert.description, 5000),
    cveId: alert.cveId ? sanitizeADFText(alert.cveId, 50) : null,
    ghsaId: alert.ghsaId ? sanitizeADFText(alert.ghsaId, 50) : null,
    url: validateUrl(alert.url),
    cvss: alert.cvss ? parseFloat(alert.cvss) : null,
    createdAt: alert.createdAt
  }

  const dueDate = calculateDueDate(
    sanitizedAlert.severity,
    config.dueDays,
    sanitizedAlert.createdAt
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
            text: `Dependabot Security Alert #${sanitizedAlert.id}`
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
            text: sanitizedAlert.package
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
            text: sanitizedAlert.ecosystem
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
            text: sanitizedAlert.severity.toUpperCase()
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
            text: sanitizedAlert.vulnerableVersionRange || 'Not available'
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
            text: sanitizedAlert.firstPatchedVersion || 'Not available'
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
            text: sanitizedAlert.description
          }
        ]
      },
      ...(sanitizedAlert.cvss
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
                  text: sanitizedAlert.cvss.toString()
                }
              ]
            }
          ]
        : []),
      ...(sanitizedAlert.cveId
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
                  text: sanitizedAlert.cveId
                }
              ]
            }
          ]
        : []),
      ...(sanitizedAlert.ghsaId
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
                  text: sanitizedAlert.ghsaId
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
            text: sanitizedAlert.url,
            marks: [
              {
                type: 'link',
                attrs: {
                  href: sanitizedAlert.url
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
      summary: `Dependabot Alert #${sanitizedAlert.id}: ${sanitizedAlert.title}`,
      description,
      issuetype: { name: issueType },
      duedate: dueDate
    }
  }

  // Priority is optional - only include if provided (some next-gen projects don't support it)
  const resolvedPriority = resolvePriority(priority, sanitizedAlert.severity)
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
 * Checks if the issue is closed and reopens it if necessary
 * @param {Object} jiraClient - Jira API client
 * @param {string} issueKey - Jira issue key
 * @param {Object} alert - Parsed Dependabot alert (used for logging only)
 * @param {boolean} dryRun - Whether this is a dry run
 * @param {string} reopenTransition - Transition name to reopen issues (default: 'Reopened')
 * @returns {Promise<Object>} Update result with { updated: false, reopened, dryRun }
 */
export async function updateJiraIssue(
  jiraClient,
  issueKey,
  alert,
  dryRun,
  reopenTransition
) {
  // In dry run mode, skip API calls (issue key might be "DRY-RUN-KEY")
  if (dryRun) {
    core.info(`[DRY RUN] Would check if issue ${issueKey} needs reopening`)
    return { updated: false, reopened: false, dryRun: true }
  }

  let reopened = false

  // Fetch the existing issue to check if it's closed
  try {
    const issueResponse = await jiraClient.get(`/issue/${issueKey}`, {
      params: {
        fields: 'status,resolution'
      }
    })

    // Check if the issue is closed by checking the resolution field
    // In Jira, if resolution is not null/empty, the issue is closed/resolved
    // This works across all Jira workflows regardless of status names
    const isClosed = issueResponse.data.fields.resolution != null

    if (isClosed) {
      const issueStatus = issueResponse.data.fields.status?.name || 'Unknown'
      const resolution =
        issueResponse.data.fields.resolution?.name || 'Resolved'
      core.info(
        `Issue ${issueKey} is resolved (Status: ${issueStatus}, Resolution: ${resolution}). ${dryRun ? 'Would reopen' : 'Reopening'}.`
      )

      const reopenResult = await reopenJiraIssue(
        jiraClient,
        issueKey,
        reopenTransition,
        `Reopening because the Dependabot alert is still open: ${alert.url}`,
        dryRun
      )

      reopened = reopenResult.reopened || false
    }
  } catch (error) {
    core.warning(
      `Could not fetch issue ${issueKey} to check status: ${error.message}`
    )
    // Continue without reopening if we can't fetch
  }

  // updateJiraIssue no longer adds comments - it only checks/reopens closed issues
  core.debug(`Checked issue ${issueKey} - reopened: ${reopened}`)

  return { updated: false, reopened, dryRun }
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

  // Use validated project key (already checked by validateProjectKey)
  const validatedProjectKey = validateJQLSafeString(projectKey)

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
  let jql = `project = "${validatedProjectKey}"`

  if (labelArray.length > 0) {
    const labelConditions = labelArray
      .map((label) => `labels = "${escapeForJQL(label)}"`)
      .join(' AND ')
    jql += ` AND ${labelConditions}`
  }

  // Filter by repository to only get issues for this specific repo
  // Instead of using URL pattern in JQL (which is injectable), we'll filter results after fetching
  // This is more secure and avoids JQL injection through owner/repo names
  const filterByRepo = owner && repo
  if (filterByRepo) {
    core.debug(`Will filter results to repository: ${owner}/${repo}`)
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
          fields: 'key,summary,description,status,resolution',
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

    // If repository filtering is requested, filter results by checking URLs in descriptions
    // This is done post-fetch to avoid JQL injection through owner/repo names
    if (filterByRepo) {
      const repoUrlPattern = `https://github.com/${owner}/${repo}/security/dependabot/`
      allIssues = allIssues.filter((issue) => {
        const urls = extractAllAlertUrlsFromIssue(issue)
        return urls.some((url) => url.startsWith(repoUrlPattern))
      })
      core.debug(
        `Filtered to ${allIssues.length} issues for repository ${owner}/${repo}`
      )
    }

    core.info(
      `Found ${allIssues.length} ${scopeMsg} Dependabot issues${repoMsg}`
    )
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
 * Extract ALL GitHub alert URLs from Jira issue description
 * @param {Object} issue - Jira issue object
 * @returns {string[]} Array of GitHub alert URLs (may be empty)
 */
export function extractAllAlertUrlsFromIssue(issue) {
  // Jira API often nests fields under 'fields' object
  const description = issue.description || issue.fields?.description

  if (!description) {
    return []
  }

  // Extract ALL GitHub alert URLs from the description (ADF format)
  // Pattern: https://github.com/{owner}/{repo}/security/dependabot/{number}
  const descriptionStr = JSON.stringify(description)
  const urlMatches = descriptionStr.matchAll(
    /https:\/\/github\.com\/[^/]+\/[^/]+\/security\/dependabot\/\d+/g
  )

  const urls = Array.from(urlMatches, (match) => match[0])

  if (urls.length > 0) {
    core.debug(
      `Extracted ${urls.length} alert URL(s) from description of ${issue.key}: ${urls.join(', ')}`
    )
  }

  return urls
}

/**
 * Extract GHSA ID from a Jira issue description
 * @param {Object} issue - Jira issue object
 * @returns {string|null} GHSA ID or null if not found
 */
export function extractGhsaIdFromIssue(issue) {
  // Jira API often nests fields under 'fields' object
  const description = issue.description || issue.fields?.description

  if (!description) {
    return null
  }

  // Extract GHSA ID from the description (ADF format)
  // Pattern: GHSA-xxxx-xxxx-xxxx (e.g., GHSA-1234-5678-9abc)
  const descriptionStr = JSON.stringify(description)
  const ghsaMatch = descriptionStr.match(
    /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i
  )

  if (ghsaMatch) {
    const ghsaId = ghsaMatch[0].toUpperCase()
    core.debug(`Extracted GHSA ID ${ghsaId} from issue ${issue.key}`)
    return ghsaId
  }

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

/**
 * Append a GitHub alert URL to an existing Jira issue description
 * @param {Object} jiraClient - Axios instance for Jira API
 * @param {string} issueKey - Jira issue key
 * @param {string} alertUrl - GitHub Dependabot alert URL to append
 * @param {boolean} dryRun - Whether this is a dry run
 * @returns {Promise<Object>} Update result
 */
export async function appendAlertUrlToIssue(
  jiraClient,
  issueKey,
  alertUrl,
  dryRun = false
) {
  if (dryRun) {
    core.info(
      `[DRY RUN] Would append alert URL to issue ${issueKey}: ${alertUrl}`
    )
    return { updated: true, dryRun: true }
  }

  try {
    // Fetch current issue to get the description
    const issueResponse = await jiraClient.get(`/issue/${issueKey}`, {
      params: {
        fields: 'description'
      }
    })

    const currentDescription = issueResponse.data.fields.description || {
      type: 'doc',
      version: 1,
      content: []
    }

    // Check if the URL is already in the description
    const descriptionStr = JSON.stringify(currentDescription)
    if (descriptionStr.includes(alertUrl)) {
      core.info(
        `Alert URL already exists in issue ${issueKey}, skipping append`
      )
      return { updated: false, alreadyExists: true }
    }

    // Append the new alert URL to the description
    const newContent = [
      ...currentDescription.content,
      {
        type: 'paragraph',
        content: []
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Additional GitHub Alert URL: ',
            marks: [{ type: 'strong' }]
          },
          {
            type: 'text',
            text: alertUrl,
            marks: [
              {
                type: 'link',
                attrs: {
                  href: alertUrl
                }
              }
            ]
          }
        ]
      }
    ]

    const updatedDescription = {
      type: 'doc',
      version: 1,
      content: newContent
    }

    // Update the issue description
    await jiraClient.put(`/issue/${issueKey}`, {
      fields: {
        description: updatedDescription
      }
    })

    core.info(`Appended alert URL to issue ${issueKey}: ${alertUrl}`)
    return { updated: true }
  } catch (error) {
    core.error(
      `Failed to append alert URL to issue ${issueKey}: ${error.message}`
    )
    throw error
  }
}

/**
 * Reopen a closed Jira issue by transitioning it to an open state
 * @param {Object} jiraClient - Axios instance for Jira API
 * @param {string} issueKey - Jira issue key
 * @param {string} reopenTransition - Transition name to reopen (e.g., "Reopened", "To Do")
 * @param {string} comment - Comment to add when reopening
 * @param {boolean} dryRun - Whether this is a dry run
 * @returns {Promise<Object>} Result of the operation
 */
export async function reopenJiraIssue(
  jiraClient,
  issueKey,
  reopenTransition,
  comment,
  dryRun = false
) {
  if (dryRun) {
    core.info(
      `[DRY RUN] Would reopen issue ${issueKey} using transition "${reopenTransition}"`
    )
    return { reopened: true, dryRun: true }
  }

  try {
    // Get available transitions for this issue
    const transitionsResponse = await jiraClient.get(
      `/issue/${issueKey}/transitions`
    )
    const availableTransitions = transitionsResponse.data.transitions || []

    // Find the transition by name (case-insensitive)
    const targetTransition = availableTransitions.find(
      (t) => t.name.toLowerCase() === reopenTransition.toLowerCase()
    )

    if (!targetTransition) {
      const availableNames = availableTransitions.map((t) => t.name).join(', ')
      core.warning(
        `Transition "${reopenTransition}" not available for issue ${issueKey}. Available transitions: ${availableNames}. Issue may already be open.`
      )
      return { reopened: false, transitionNotAvailable: true }
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

    core.info(
      `Reopened Jira issue: ${issueKey} using transition "${reopenTransition}"`
    )
    return { reopened: true }
  } catch (error) {
    core.error(`Failed to reopen Jira issue ${issueKey}: ${error.message}`)
    throw error
  }
}
