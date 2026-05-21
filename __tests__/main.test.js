/**
 * Unit tests for the action's main functionality, src/main.js
 */
import { jest } from '@jest/globals'

// Mock modules
const mockCore = {
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}

const mockGithub = {
  getRepoInfo: jest.fn(),
  getDependabotAlerts: jest.fn(),
  parseAlert: jest.fn(),
  getAlertStatus: jest.fn()
}

const mockJira = {
  createJiraClient: jest.fn(),
  createJiraIssue: jest.fn(),
  updateJiraIssue: jest.fn(),
  findDependabotIssues: jest.fn(),
  extractAlertUrlFromIssue: jest.fn(),
  extractAllAlertUrlsFromIssue: jest.fn(),
  extractGhsaIdFromIssue: jest.fn(),
  extractAlertIdFromUrl: jest.fn(),
  closeJiraIssue: jest.fn(),
  appendAlertUrlToIssue: jest.fn(),
  reopenJiraIssue: jest.fn()
}

// Mock the modules before importing the main function
jest.unstable_mockModule('@actions/core', () => mockCore)
jest.unstable_mockModule('../src/github.js', () => mockGithub)
jest.unstable_mockModule('../src/jira.js', () => mockJira)

// Import the module being tested
const { run } = await import('../src/main.js')

describe('Dependabot Jira Sync', () => {
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks()

    // Set default environment variable
    process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'

    // Set default inputs
    mockCore.getInput.mockImplementation((name) => {
      const inputs = {
        'github-token': 'test-token',
        'jira-url': 'https://test.atlassian.net',
        'jira-username': 'test@example.com',
        'jira-api-token': 'test-api-token',
        'jira-project-key': 'TEST',
        'jira-issue-type': 'Bug',
        'jira-priority': 'Medium',
        'jira-labels': 'dependabot,security',
        'severity-threshold': 'medium',
        'critical-due-days': '1',
        'high-due-days': '7',
        'medium-due-days': '30',
        'low-due-days': '90'
      }
      return inputs[name] || ''
    })

    mockCore.getBooleanInput.mockImplementation((name) => {
      const booleanInputs = {
        'exclude-dismissed': true,
        'update-existing': true,
        'auto-close-resolved': false,
        'dry-run': false
      }
      return booleanInputs[name] || false
    })

    // Mock GitHub functions
    mockGithub.getRepoInfo.mockReturnValue({
      owner: 'test-owner',
      repo: 'test-repo'
    })

    mockGithub.getDependabotAlerts.mockResolvedValue([])

    // Mock Jira functions
    mockJira.createJiraClient.mockReturnValue({
      // Mock Jira client
    })

    mockJira.findDependabotIssues.mockResolvedValue([]) // No existing issues by default
    mockJira.extractAlertUrlFromIssue.mockReturnValue(null)
    mockJira.extractGhsaIdFromIssue.mockReturnValue(null) // No GHSA by default
    mockJira.extractAlertIdFromUrl.mockReturnValue(null)
    mockJira.appendAlertUrlToIssue.mockResolvedValue({ updated: true })
    mockJira.reopenJiraIssue.mockResolvedValue({ reopened: true })
    mockJira.createJiraIssue.mockResolvedValue({ key: 'TEST-123' })
    mockJira.updateJiraIssue.mockResolvedValue({ updated: true })
  })

  afterEach(() => {
    delete process.env.GITHUB_REPOSITORY
  })

  it('processes no alerts successfully', async () => {
    mockGithub.getDependabotAlerts.mockResolvedValue([])

    await run()

    expect(mockCore.setOutput).toHaveBeenCalledWith('issues-created', '0')
    expect(mockCore.setOutput).toHaveBeenCalledWith('issues-updated', '0')
    expect(mockCore.setOutput).toHaveBeenCalledWith('alerts-processed', '0')
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'summary',
      'No alerts to process'
    )
    expect(mockCore.info).toHaveBeenCalledWith(
      '✅ No Dependabot alerts found matching the criteria'
    )
  })

  it('creates new Jira issues for alerts', async () => {
    const mockAlert = {
      number: 1,
      security_advisory: {
        summary: 'Test vulnerability',
        description: 'A test vulnerability',
        severity: 'high'
      },
      dependency: {
        package: { name: 'test-package', ecosystem: 'npm' }
      },
      html_url: 'https://github.com/test/alert/1',
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-01T00:00:00Z',
      state: 'open'
    }

    const parsedAlert = {
      id: 1,
      title: 'Test vulnerability',
      description: 'A test vulnerability',
      severity: 'high',
      package: 'test-package',
      ecosystem: 'npm'
    }

    mockGithub.getDependabotAlerts.mockResolvedValue([mockAlert])
    mockGithub.parseAlert.mockReturnValue(parsedAlert)
    // No existing issues
    mockJira.findDependabotIssues.mockResolvedValue([])
    mockJira.createJiraIssue.mockResolvedValue({ key: 'TEST-123' })

    await run()

    expect(mockJira.createJiraIssue).toHaveBeenCalledWith(
      expect.any(Object), // jiraClient
      expect.objectContaining({
        projectKey: 'TEST',
        issueType: 'Bug',
        priority: 'Medium'
      }),
      parsedAlert,
      false // dryRun
    )

    expect(mockCore.setOutput).toHaveBeenCalledWith('issues-created', '1')
    expect(mockCore.setOutput).toHaveBeenCalledWith('issues-updated', '0')
    expect(mockCore.setOutput).toHaveBeenCalledWith('alerts-processed', '1')
  })

  it('updates existing Jira issues', async () => {
    const mockAlert = {
      number: 1,
      security_advisory: {
        summary: 'Test vulnerability',
        severity: 'medium'
      },
      dependency: {
        package: { name: 'test-package' }
      },
      html_url: 'https://github.com/test/alert/1',
      state: 'open'
    }

    const parsedAlert = {
      id: 1,
      title: 'Test vulnerability',
      severity: 'medium',
      url: 'https://github.com/test/alert/1'
    }

    const existingIssue = { key: 'TEST-456' }

    mockGithub.getDependabotAlerts.mockResolvedValue([mockAlert])
    mockGithub.parseAlert.mockReturnValue(parsedAlert)
    // Mock existing issue found by URL
    mockJira.findDependabotIssues.mockResolvedValue([existingIssue])
    mockJira.extractAlertUrlFromIssue.mockReturnValue(
      'https://github.com/test/alert/1'
    )

    await run()

    expect(mockJira.updateJiraIssue).toHaveBeenCalledWith(
      expect.any(Object), // jiraClient
      'TEST-456',
      parsedAlert,
      false, // dryRun
      'Reopen' // reopenTransition
    )

    expect(mockCore.setOutput).toHaveBeenCalledWith('issues-created', '0')
    expect(mockCore.setOutput).toHaveBeenCalledWith('issues-updated', '1')
  })

  it('handles dry run mode', async () => {
    mockCore.getBooleanInput.mockImplementation((name) => {
      if (name === 'dry-run') return true
      return false
    })

    const mockAlert = {
      number: 1,
      security_advisory: { summary: 'Test', severity: 'high' },
      dependency: { package: { name: 'test' } },
      html_url: 'https://test.com',
      state: 'open'
    }

    mockGithub.getDependabotAlerts.mockResolvedValue([mockAlert])
    mockGithub.parseAlert.mockReturnValue({ id: 1, severity: 'high' })
    mockJira.findDependabotIssues.mockResolvedValue([])
    mockJira.createJiraIssue.mockResolvedValue({
      key: 'DRY-RUN-KEY',
      dryRun: true
    })

    await run()

    expect(mockCore.warning).toHaveBeenCalledWith(
      '🧪 DRY RUN MODE - No changes will be made'
    )
    expect(mockJira.createJiraIssue).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
      true // dryRun = true
    )
  })

  it('handles missing required inputs', async () => {
    mockCore.getInput.mockImplementation((name, options) => {
      if (options?.required && name === 'jira-url') {
        throw new Error(`Input required and not supplied: ${name}`)
      }
      return ''
    })

    await run()

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Input required and not supplied: jira-url')
    )
  })

  it('handles GitHub API errors', async () => {
    mockGithub.getDependabotAlerts.mockRejectedValue(
      new Error('GitHub API rate limit exceeded')
    )

    await run()

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      'GitHub API rate limit exceeded'
    )
  })

  it('fails the run when Jira processing errors occur', async () => {
    const mockAlert = {
      number: 99,
      security_advisory: { summary: 'Failing alert', severity: 'high' },
      dependency: { package: { name: 'test' } },
      html_url: 'https://test.com',
      state: 'open'
    }

    const parsedAlert = { id: 99, title: 'Failing alert', severity: 'high' }

    mockGithub.getDependabotAlerts.mockResolvedValue([mockAlert])
    mockGithub.parseAlert.mockReturnValue(parsedAlert)
    mockJira.findDependabotIssues.mockResolvedValue([])
    mockJira.createJiraIssue.mockRejectedValue(new Error('Jira blew up'))

    await run()

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      'Failed to process 1 alert(s); see logs for details'
    )
  })

  it('auto-closes resolved Jira issues when enabled', async () => {
    mockCore.getBooleanInput.mockImplementation((name) => {
      if (name === 'auto-close-resolved') return true
      return false
    })

    const mockAlert = {
      number: 7,
      security_advisory: { summary: 'Test', severity: 'high' },
      dependency: { package: { name: 'pkg' } },
      html_url: 'https://example.com',
      state: 'open'
    }

    const parsedAlert = { id: 7, title: 'Test', severity: 'high' }

    mockGithub.getDependabotAlerts.mockResolvedValue([mockAlert])
    mockGithub.parseAlert.mockReturnValue(parsedAlert)
    // First call: fetch all existing issues (empty)
    // Second call: fetch open issues for auto-close
    mockJira.findDependabotIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          key: 'TEST-1',
          fields: {
            status: { name: 'To Do' }
          }
        }
      ])
    mockJira.createJiraIssue.mockResolvedValue({ key: 'TEST-7' })

    // Auto-close path - issue has status field
    mockJira.extractAllAlertUrlsFromIssue.mockReturnValue([
      'https://github.com/test-owner/test-repo/security/dependabot/7'
    ])
    mockJira.extractAlertIdFromUrl.mockReturnValue('7')
    mockGithub.getAlertStatus.mockResolvedValue('fixed')
    mockJira.closeJiraIssue.mockResolvedValue({ closed: true })

    await run()

    expect(mockJira.closeJiraIssue).toHaveBeenCalledWith(
      expect.any(Object),
      'TEST-1',
      'Done',
      expect.stringContaining('All 1 associated Dependabot alert(s)'),
      false
    )
    expect(mockCore.setOutput).toHaveBeenCalledWith('issues-closed', '1')
  })

  it('should NOT auto-close issue when some alerts from current repo are still open', async () => {
    mockCore.getBooleanInput.mockImplementation((name) => {
      if (name === 'auto-close-resolved') return true
      return false
    })

    const mockAlert = {
      number: 7,
      security_advisory: { summary: 'Test', severity: 'high' },
      dependency: { package: { name: 'pkg' } },
      html_url: 'https://example.com',
      state: 'open'
    }

    const parsedAlert = { id: 7, title: 'Test', severity: 'high' }

    mockGithub.getDependabotAlerts.mockResolvedValue([mockAlert])
    mockGithub.parseAlert.mockReturnValue(parsedAlert)
    mockJira.findDependabotIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          key: 'TEST-1',
          fields: {
            status: { name: 'To Do' }
          }
        }
      ])
    mockJira.createJiraIssue.mockResolvedValue({ key: 'TEST-7' })

    // Issue has TWO alerts from current repo
    mockJira.extractAllAlertUrlsFromIssue.mockReturnValue([
      'https://github.com/test-owner/test-repo/security/dependabot/7',
      'https://github.com/test-owner/test-repo/security/dependabot/8'
    ])
    mockJira.extractAlertIdFromUrl
      .mockReturnValueOnce('7')
      .mockReturnValueOnce('8')
    // Alert 7 is fixed, but alert 8 is still open
    mockGithub.getAlertStatus
      .mockResolvedValueOnce('fixed')
      .mockResolvedValueOnce('open')

    await run()

    // Should NOT close because alert 8 is still open
    expect(mockJira.closeJiraIssue).not.toHaveBeenCalled()
    expect(mockCore.setOutput).toHaveBeenCalledWith('issues-closed', '0')
  })

  it('should auto-close issue only when ALL alerts from current repo are resolved', async () => {
    mockCore.getBooleanInput.mockImplementation((name) => {
      if (name === 'auto-close-resolved') return true
      return false
    })

    const mockAlert = {
      number: 7,
      security_advisory: { summary: 'Test', severity: 'high' },
      dependency: { package: { name: 'pkg' } },
      html_url: 'https://example.com',
      state: 'open'
    }

    const parsedAlert = { id: 7, title: 'Test', severity: 'high' }

    mockGithub.getDependabotAlerts.mockResolvedValue([mockAlert])
    mockGithub.parseAlert.mockReturnValue(parsedAlert)
    mockJira.findDependabotIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          key: 'TEST-1',
          fields: {
            status: { name: 'To Do' }
          }
        }
      ])
    mockJira.createJiraIssue.mockResolvedValue({ key: 'TEST-7' })

    // Issue has TWO alerts from current repo
    mockJira.extractAllAlertUrlsFromIssue.mockReturnValue([
      'https://github.com/test-owner/test-repo/security/dependabot/7',
      'https://github.com/test-owner/test-repo/security/dependabot/8'
    ])
    mockJira.extractAlertIdFromUrl
      .mockReturnValueOnce('7')
      .mockReturnValueOnce('8')
    // Both alerts are fixed
    mockGithub.getAlertStatus
      .mockResolvedValueOnce('fixed')
      .mockResolvedValueOnce('fixed')
    mockJira.closeJiraIssue.mockResolvedValue({ closed: true })

    await run()

    // Should close because both alerts are resolved
    expect(mockJira.closeJiraIssue).toHaveBeenCalledWith(
      expect.any(Object),
      'TEST-1',
      'Done',
      expect.stringContaining('All 2 associated Dependabot alert(s)'),
      false
    )
    expect(mockCore.setOutput).toHaveBeenCalledWith('issues-closed', '1')
  })

  it('should reopen closed issue when URL match finds a closed Jira issue', async () => {
    const mockAlert = {
      number: 1,
      security_advisory: {
        summary: 'Test vulnerability',
        severity: 'medium'
      },
      dependency: {
        package: { name: 'test-package' }
      },
      html_url: 'https://github.com/test/alert/1',
      state: 'open'
    }

    const parsedAlert = {
      id: 1,
      title: 'Test vulnerability',
      severity: 'medium',
      url: 'https://github.com/test/alert/1'
    }

    const existingClosedIssue = {
      key: 'TEST-456',
      fields: {
        status: { name: 'Done' } // Issue is CLOSED
      }
    }

    mockGithub.getDependabotAlerts.mockResolvedValue([mockAlert])
    mockGithub.parseAlert.mockReturnValue(parsedAlert)
    // Mock existing issue found by URL, but it's closed
    mockJira.findDependabotIssues.mockResolvedValue([existingClosedIssue])
    mockJira.extractAlertUrlFromIssue.mockReturnValue(
      'https://github.com/test/alert/1'
    )
    mockJira.updateJiraIssue.mockResolvedValue({
      updated: true,
      reopened: true
    })

    await run()

    // Should reopen because the matched issue is closed but alert is still open
    // updateJiraIssue now handles reopening internally, so check it was called
    expect(mockJira.updateJiraIssue).toHaveBeenCalledWith(
      expect.any(Object),
      'TEST-456',
      parsedAlert,
      false,
      'Reopen'
    )
    expect(mockCore.setOutput).toHaveBeenCalledWith('issues-reopened', '1')
    expect(mockCore.setOutput).toHaveBeenCalledWith('issues-updated', '1')
  })

  it('should reopen closed issue when alerts from current repo are still open', async () => {
    mockCore.getBooleanInput.mockImplementation((name) => {
      if (name === 'auto-close-resolved') return true
      return false
    })

    const mockAlert = {
      number: 7,
      security_advisory: { summary: 'Test', severity: 'high' },
      dependency: { package: { name: 'pkg' } },
      html_url: 'https://example.com',
      state: 'open'
    }

    const parsedAlert = { id: 7, title: 'Test', severity: 'high' }

    mockGithub.getDependabotAlerts.mockResolvedValue([mockAlert])
    mockGithub.parseAlert.mockReturnValue(parsedAlert)
    mockJira.findDependabotIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          key: 'TEST-1',
          fields: {
            status: { name: 'Done' } // Issue is CLOSED
          }
        }
      ])
    mockJira.createJiraIssue.mockResolvedValue({ key: 'TEST-7' })

    // Issue has an alert from current repo
    mockJira.extractAllAlertUrlsFromIssue.mockReturnValue([
      'https://github.com/test-owner/test-repo/security/dependabot/7'
    ])
    mockJira.extractAlertIdFromUrl.mockReturnValue('7')
    // Alert is still OPEN
    mockGithub.getAlertStatus.mockResolvedValue('open')
    mockJira.reopenJiraIssue.mockResolvedValue({ reopened: true })

    await run()

    // Should reopen because alert is still open but issue is closed
    expect(mockJira.reopenJiraIssue).toHaveBeenCalledWith(
      expect.any(Object),
      'TEST-1',
      'Reopen',
      expect.stringContaining('still has open Dependabot alerts'),
      false
    )
    expect(mockCore.setOutput).toHaveBeenCalledWith('issues-reopened', '1')
  })

  it('should group alerts by GHSA using in-memory lookup instead of API call', async () => {
    const mockAlert1 = {
      number: 1,
      security_advisory: {
        summary: 'GHSA-xxxx-yyyy-zzzz',
        severity: 'high',
        ghsa_id: 'GHSA-xxxx-yyyy-zzzz'
      },
      dependency: { package: { name: 'pkg' } },
      html_url: 'https://github.com/test-owner/test-repo/security/dependabot/1',
      state: 'open'
    }

    const mockAlert2 = {
      number: 2,
      security_advisory: {
        summary: 'GHSA-xxxx-yyyy-zzzz',
        severity: 'high',
        ghsa_id: 'GHSA-xxxx-yyyy-zzzz'
      },
      dependency: { package: { name: 'other-pkg' } },
      html_url: 'https://github.com/test-owner/test-repo/security/dependabot/2',
      state: 'open'
    }

    const parsedAlert1 = {
      id: 1,
      title: 'GHSA-xxxx-yyyy-zzzz',
      severity: 'high',
      ghsaId: 'GHSA-xxxx-yyyy-zzzz',
      url: 'https://github.com/test-owner/test-repo/security/dependabot/1'
    }

    const parsedAlert2 = {
      id: 2,
      title: 'GHSA-xxxx-yyyy-zzzz',
      severity: 'high',
      ghsaId: 'GHSA-xxxx-yyyy-zzzz',
      url: 'https://github.com/test-owner/test-repo/security/dependabot/2'
    }

    mockGithub.getDependabotAlerts.mockResolvedValue([mockAlert1, mockAlert2])
    mockGithub.parseAlert
      .mockReturnValueOnce(parsedAlert1)
      .mockReturnValueOnce(parsedAlert2)

    // First alert creates an issue
    mockJira.findDependabotIssues.mockResolvedValue([])
    mockJira.createJiraIssue.mockResolvedValue({
      key: 'TEST-1',
      fields: {
        description: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'GHSA-xxxx-yyyy-zzzz' }]
            }
          ]
        }
      }
    })
    mockJira.extractGhsaIdFromIssue.mockReturnValue('GHSA-xxxx-yyyy-zzzz')
    mockJira.appendAlertUrlToIssue.mockResolvedValue({ updated: true })

    await run()

    // Should create one issue
    expect(mockJira.createJiraIssue).toHaveBeenCalledTimes(1)

    // Should append the second alert to the first issue (in-memory lookup)
    expect(mockJira.appendAlertUrlToIssue).toHaveBeenCalledWith(
      expect.any(Object),
      'TEST-1',
      'https://github.com/test-owner/test-repo/security/dependabot/2',
      false
    )

    expect(mockCore.setOutput).toHaveBeenCalledWith('issues-created', '1')
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'alerts-grouped-by-ghsa',
      '1'
    )
  })

  it('should use existing GHSA issues from initial fetch instead of making API calls', async () => {
    const mockAlert = {
      number: 2,
      security_advisory: {
        summary: 'GHSA-aaaa-bbbb-cccc',
        severity: 'high',
        ghsa_id: 'GHSA-aaaa-bbbb-cccc'
      },
      dependency: { package: { name: 'pkg' } },
      html_url: 'https://github.com/test-owner/test-repo/security/dependabot/2',
      state: 'open'
    }

    const parsedAlert = {
      id: 2,
      title: 'GHSA-aaaa-bbbb-cccc',
      severity: 'high',
      ghsaId: 'GHSA-aaaa-bbbb-cccc',
      url: 'https://github.com/test-owner/test-repo/security/dependabot/2'
    }

    mockGithub.getDependabotAlerts.mockResolvedValue([mockAlert])
    mockGithub.parseAlert.mockReturnValue(parsedAlert)

    // Existing issue with same GHSA (different alert URL)
    const existingIssue = {
      key: 'TEST-100',
      fields: {
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'GHSA ID: GHSA-aaaa-bbbb-cccc'
                }
              ]
            },
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'https://github.com/test-owner/test-repo/security/dependabot/1'
                }
              ]
            }
          ]
        },
        status: { name: 'To Do' }
      }
    }

    mockJira.findDependabotIssues.mockResolvedValue([existingIssue])
    mockJira.extractAlertUrlFromIssue.mockReturnValue(
      'https://github.com/test-owner/test-repo/security/dependabot/1'
    )
    mockJira.extractGhsaIdFromIssue.mockReturnValue('GHSA-aaaa-bbbb-cccc')
    mockJira.appendAlertUrlToIssue.mockResolvedValue({ updated: true })

    await run()

    // Should NOT create a new issue
    expect(mockJira.createJiraIssue).not.toHaveBeenCalled()

    // Should append to existing issue (found via in-memory GHSA lookup)
    expect(mockJira.appendAlertUrlToIssue).toHaveBeenCalledWith(
      expect.any(Object),
      'TEST-100',
      'https://github.com/test-owner/test-repo/security/dependabot/2',
      false
    )

    expect(mockCore.setOutput).toHaveBeenCalledWith('issues-created', '0')
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'alerts-grouped-by-ghsa',
      '1'
    )
  })

  it('validates config inputs and fails fast on invalid values', async () => {
    mockCore.getInput.mockImplementation((name, options) => {
      const inputs = {
        'jira-url': 'not-a-url',
        'jira-username': 'user@test.com',
        'jira-api-token': 'token',
        'jira-project-key': 'BAD KEY', // space invalid
        'severity-threshold': 'invalid',
        'critical-due-days': '0', // out of range
        'high-due-days': '7',
        'medium-due-days': '30',
        'low-due-days': '90'
      }
      if (options?.required && !inputs[name]) {
        throw new Error(`Input required and not supplied: ${name}`)
      }
      return inputs[name] || ''
    })

    mockCore.getBooleanInput.mockReturnValue(false)

    await run()

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Invalid Jira URL format')
    )
  })
})
