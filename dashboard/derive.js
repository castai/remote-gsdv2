/**
 * derive.js — maps raw GSD state to board columns and attention states.
 *
 * This module is pure: no I/O, no side effects.
 *
 * Exports:
 *   deriveMilestone(milestone, context) → { phase, attention, attentionDetail }
 *   deriveInstance(rawState)            → rawState enriched with derived fields
 *
 * Phase columns (in lifecycle order):
 *   Discussing | Researching | Planning | Executing | Validating | Done
 *
 * Attention states (in urgency order, highest first):
 *   Errored | Blocked | AwaitingVerification | QuestionPending | Healthy
 */

// ─── Phase derivation ────────────────────────────────────────────────────────

const RESEARCH_SIGNALS = ['research', 'researching', 'investigate', 'spike']

/**
 * Returns true if any slice or the live journal unit indicates a research phase.
 */
function hasResearchSignal(slices, recentJournalEvents) {
  // Slice title or goal contains research keywords
  for (const sl of slices) {
    const text = `${sl.title || ''} ${sl.goal || ''}`.toLowerCase()
    if (RESEARCH_SIGNALS.some(s => text.includes(s))) return true
  }
  // Active journal unit type is research
  for (const ev of (recentJournalEvents || [])) {
    if (ev.unitId && ev.unitId.includes('research')) return true
  }
  return false
}

/**
 * Derive the board column (phase) for one milestone.
 * pausedSession is passed in to handle the case where slices still show
 * 'pending' in the manifest but execution is clearly under way.
 */
function derivePhase(milestone, slices, tasks, recentJournalEvents, pausedSession) {
  const { status } = milestone

  if (status === 'complete') return 'Done'
  if (status === 'skipped')  return 'Done'

  // Active milestone
  if (!slices || slices.length === 0) return 'Discussing'

  // If a paused session references this milestone, execution has started
  // even if slices haven't been marked in_progress yet in the manifest.
  const executionUnderway = pausedSession && pausedSession.milestoneId === milestone.id

  const allPending    = slices.every(sl => sl.status === 'pending')
  const anyInProgress = slices.some(sl => sl.status === 'in_progress') || executionUnderway
  const allComplete   = slices.every(sl => sl.status === 'complete' || sl.status === 'skipped')

  if (allPending) {
    // Execution has started (paused session signals it) but manifest hasn't
    // caught up yet — treat as Executing.
    if (executionUnderway) return 'Executing'
    // Has slices planned but none started — check if there's a plan yet
    const hasPlans = slices.some(sl => sl.goal && sl.goal.trim())
    return hasPlans ? 'Planning' : 'Discussing'
  }

  if (allComplete) {
    // All slices done but milestone not closed — in validation round
    return 'Validating'
  }

  if (anyInProgress) {
    // Check for research signal — look at in_progress slices or paused unit
    const inProgressSlices = slices.filter(sl => sl.status === 'in_progress')
    // If paused session is the signal, use all slices for research check
    const checkSlices = inProgressSlices.length ? inProgressSlices : slices
    if (hasResearchSignal(checkSlices, recentJournalEvents)) return 'Researching'
    return 'Executing'
  }

  // Mixed: some complete, some pending, none in_progress — between slices
  // (reassessment phase). Show as Planning.
  return 'Planning'
}

// ─── Attention derivation ────────────────────────────────────────────────────

/**
 * Derive the attention state for one milestone.
 * Returns { attention, attentionDetail }
 */
function deriveAttention(milestone, { pausedSession, stuckState, recentNotifications, lastError }) {
  const mid = milestone.id

  const isPaused = pausedSession && pausedSession.milestoneId === mid

  if (isPaused) {
    // Prefer the structured lastError from the journal — it has the real message
    if (lastError && lastError.unitId && lastError.unitId.startsWith(mid + '/')) {
      const isTimeout  = lastError.category === 'timeout'
      const label      = isTimeout ? 'Timed out' : 'Errored'
      const transient  = lastError.isTransient ? ' (transient)' : ''
      return {
        attention: 'Errored',
        attentionDetail: `${lastError.unitId} ${lastError.status ?? 'cancelled'}${transient}: ${lastError.message}`
      }
    }

    // Fall back to stuckState recentUnits
    const recentUnits = stuckState?.recentUnits || []
    const milestoneErrors = recentUnits.filter(u => {
      const key = u.key || ''
      return (key.includes(`/${mid}/`) || key.includes(`/${mid}`)) && u.error
    })

    if (milestoneErrors.length > 0) {
      const lastUnit = milestoneErrors[milestoneErrors.length - 1]
      let detail = 'Agent execution errored'
      try {
        const parsed = JSON.parse(lastUnit.error)
        const txt = parsed?.content?.[0]?.text
        if (txt) detail = txt.slice(0, 120).trim()
      } catch {
        if (typeof lastUnit.error === 'string') {
          detail = lastUnit.error.slice(0, 120)
        }
      }
      return {
        attention: 'Errored',
        attentionDetail: `${pausedSession.unitId} paused with error: ${detail}`
      }
    }

    // Paused but no error found — blocked waiting for input
    return {
      attention: 'Blocked',
      attentionDetail: `Auto-mode paused at ${pausedSession.unitId} since ${pausedSession.pausedAt?.slice(0, 19) ?? 'unknown'}`
    }
  }

  // Not paused: check lastError if it's recent and for this milestone
  if (lastError && lastError.unitId && lastError.unitId.startsWith(mid + '/')) {
    return {
      attention: 'Errored',
      attentionDetail: `${lastError.unitId} ${lastError.status ?? 'cancelled'}: ${lastError.message}`
    }
  }

  // stuckState fallback
  if (stuckState) {
    const recentUnits = stuckState.recentUnits || []
    const lastUnit = recentUnits[recentUnits.length - 1]
    if (lastUnit?.error && (lastUnit.key || '').includes(mid)) {
      return {
        attention: 'Errored',
        attentionDetail: `Last unit errored: ${lastUnit.key}`
      }
    }
  }

  // QuestionPending
  const questionNotif = (recentNotifications || []).find(n => {
    const msg = (n.message || '').toLowerCase()
    return (
      msg.includes('question') ||
      msg.includes('awaiting') ||
      msg.includes('needs input') ||
      msg.includes('blocked on')
    ) && n.severity === 'warning'
  })
  if (questionNotif) {
    return {
      attention: 'QuestionPending',
      attentionDetail: questionNotif.message.slice(0, 120)
    }
  }

  return { attention: 'Healthy', attentionDetail: null }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Derive phase and attention for one milestone.
 *
 * @param {object} milestone  - Raw milestone from state-manifest
 * @param {object} context
 * @param {array}  context.slices              - Slices belonging to this milestone
 * @param {array}  context.tasks               - Tasks belonging to this milestone
 * @param {object} context.pausedSession       - From runtime/paused-session.json
 * @param {object} context.stuckState          - From runtime/stuck-state.json
 * @param {array}  context.recentNotifications - From notifications.jsonl
 * @param {array}  context.recentJournalEvents - From journal tail
 * @returns {{ phase, attention, attentionDetail }}
 */
export function deriveMilestone(milestone, {
  slices = [],
  tasks = [],
  pausedSession = null,
  stuckState = null,
  recentNotifications = [],
  recentJournalEvents = [],
  lastError = null
} = {}) {
  const phase = derivePhase(milestone, slices, tasks, recentJournalEvents, pausedSession)
  const { attention, attentionDetail } = deriveAttention(milestone, {
    pausedSession,
    stuckState,
    recentNotifications,
    lastError
  })

  if (phase === 'Unknown') {
    console.warn('[derive] unmatched state for milestone', milestone.id, {
      status: milestone.status,
      sliceCounts: {
        total: slices.length,
        pending: slices.filter(s => s.status === 'pending').length,
        in_progress: slices.filter(s => s.status === 'in_progress').length,
        complete: slices.filter(s => s.status === 'complete').length
      }
    })
  }

  return { phase, attention, attentionDetail }
}

/**
 * Enrich a full raw state payload (from readInstance) with derived fields.
 * Returns a new object — does not mutate the input.
 *
 * @param {object} rawState - Output of readInstance()
 * @returns {object} Same shape with milestones enriched with {phase, attention, attentionDetail}
 */
export function deriveInstance(rawState) {
  if (rawState.stale || rawState.error) return rawState

  const {
    milestones = [],
    slices = [],
    tasks = [],
    pausedSession,
    stuckState,
    recentNotifications = [],
    recentJournalEvents = [],
    lastError = null
  } = rawState

  const enrichedMilestones = milestones.map(milestone => {
    const msSlices = slices.filter(sl => sl.milestone_id === milestone.id)
    const msTasks  = tasks.filter(t => t.milestone_id === milestone.id)

    const derived = deriveMilestone(milestone, {
      slices: msSlices,
      tasks: msTasks,
      pausedSession,
      stuckState,
      recentNotifications,
      recentJournalEvents,
      lastError
    })

    return { ...milestone, ...derived }
  })

  return { ...rawState, milestones: enrichedMilestones }
}
