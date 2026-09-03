import Link from 'next/link'
import { notFound } from 'next/navigation'

import { istDateKey, istHour } from '../../../../core/calendar'
import { formatINR, paise } from '../../../../core/money'
import { Disclosure } from '../../../components/disclosure'
import { Term } from '../../../components/term'
import { caseDetail, type TimelineEntry } from '../../../lib/console-data'

export const dynamic = 'force-dynamic'

const TONE_COLOUR: Readonly<Record<TimelineEntry['tone'], string>> = {
  neutral: 'var(--text-faint)',
  good: 'var(--ok)',
  bad: 'var(--bad)',
  accent: 'var(--accent)',
}

function stamp(at: number): string {
  return `${istDateKey(at)} ${String(istHour(at)).padStart(2, '0')}:00`
}

interface Evaluation {
  readonly ruleId: string
  readonly verdict: string
  readonly detail: string
  readonly action?: string
  readonly channel?: string
}

function evaluations(value: unknown): Evaluation[] {
  return Array.isArray(value) ? (value as Evaluation[]) : []
}

interface Candidate {
  readonly action: string
  readonly channel?: string
  readonly uplift: number
  readonly evPaise: number
  readonly costPaise: number
  readonly rationale: string
}

function candidates(value: unknown): Candidate[] {
  return Array.isArray(value) ? (value as Candidate[]) : []
}

function verdictTag(verdict: string): string {
  if (verdict === 'DENY' || verdict === 'STOP') return 'tag-bad'
  if (verdict === 'DEFER' || verdict === 'MODIFY') return 'tag-warn'
  return ''
}

function DecisionTrace({ payload }: { readonly payload: Record<string, unknown> }) {
  const policy = evaluations(payload['policyEvaluations'])
  const stops = evaluations(payload['stopEvaluations'])
  const scored = candidates(payload['candidates'])
  const blocking = stops.filter((entry) => entry.verdict !== 'CONTINUE')

  return (
    <div className="stagger">
      <dl className="kv" style={{ ['--i' as string]: 0, marginBottom: 10 }}>
        <dt>Propensity</dt>
        <dd>{String(payload['propensity'])}</dd>
        <dt>Chosen by</dt>
        <dd>{String(payload['chosenBy'])}</dd>
        <dt>Policy version</dt>
        <dd>{String(payload['policyVersion'])}</dd>
        <dt>Playbook</dt>
        <dd>{String(payload['playbookVersion'])}</dd>
        <dt>Audit hash</dt>
        <dd className="dim">{String(payload['hash']).slice(0, 32)}…</dd>
      </dl>

      {scored.length > 0 ? (
        <div style={{ ['--i' as string]: 1, marginBottom: 10 }}>
          <div className="stat-label" style={{ marginBottom: 4 }}>
            Candidates considered
          </div>
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th className="right">Uplift</th>
                <th className="right">
                  <Term name="ev">EV</Term>
                </th>
                <th className="right">Cost</th>
                <th>Rationale</th>
              </tr>
            </thead>
            <tbody>
              {scored.map((candidate, index) => (
                <tr key={`${candidate.action}-${index}`}>
                  <td className="num">
                    {candidate.action}
                    {candidate.channel === undefined ? '' : ` · ${candidate.channel}`}
                  </td>
                  <td className="right num">{candidate.uplift.toFixed(4)}</td>
                  <td className={`right num ${candidate.evPaise > 0 ? 'pos' : 'neg'}`}>
                    {formatINR(paise(Math.round(candidate.evPaise)))}
                  </td>
                  <td className="right num dim">
                    {formatINR(paise(Math.round(candidate.costPaise)))}
                  </td>
                  <td className="dim">{candidate.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div style={{ ['--i' as string]: 2, marginBottom: 10 }}>
        <div className="stat-label" style={{ marginBottom: 4 }}>
          Policy evaluations recorded ({policy.length})
        </div>
        {policy.length === 0 ? (
          <div className="dim" style={{ fontSize: 11.5 }}>
            Every rule allowed this action.
          </div>
        ) : (
          <table>
            <tbody>
              {policy.map((entry, index) => (
                <tr key={`${entry.ruleId}-${index}`}>
                  <td className="num">{entry.ruleId}</td>
                  <td>
                    <span className={`tag ${verdictTag(entry.verdict)}`}>{entry.verdict}</span>
                  </td>
                  <td className="num dim">
                    {entry.action ?? ''}
                    {entry.channel === undefined ? '' : ` · ${entry.channel}`}
                  </td>
                  <td className="dim">{entry.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ ['--i' as string]: 3 }}>
        <div className="stat-label" style={{ marginBottom: 4 }}>
          Stop gate: {stops.length} conditions evaluated, {blocking.length} blocking
        </div>
        {blocking.length === 0 ? (
          <div className="dim" style={{ fontSize: 11.5 }}>
            All {stops.length} stop conditions returned CONTINUE.
          </div>
        ) : (
          <table>
            <tbody>
              {blocking.map((entry, index) => (
                <tr key={`${entry.ruleId}-${index}`}>
                  <td className="num">{entry.ruleId}</td>
                  <td>
                    <span className={`tag ${verdictTag(entry.verdict)}`}>{entry.verdict}</span>
                  </td>
                  <td className="dim">{entry.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

export default async function CaseDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>
}): Promise<React.ReactElement> {
  const { id } = await params
  const detail = await caseDetail(id)
  if (detail === undefined) notFound()

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title num">{detail.row.id}</h1>
          <p className="page-note">
            <Link href="/cases" style={{ color: 'var(--accent)' }}>
              ← all cases
            </Link>{' '}
            · The explanation below renders from the stored audit record. Nothing is recomputed at
            render time.
          </p>
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 12 }}>
        <div className="stat">
          <div className="stat-label">State</div>
          <div className="stat-value" style={{ fontSize: 15 }}>
            {detail.row.state}
          </div>
          <div className="stat-sub">
            {detail.row.arm} · {detail.row.type}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Outstanding</div>
          <div className="stat-value">{formatINR(detail.outstandingPaise)}</div>
          <div className="stat-sub">billed {formatINR(detail.row.amountPaise)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Diagnosis</div>
          <div className="stat-value" style={{ fontSize: 15 }}>
            {detail.row.failureClass}
          </div>
          <div className="stat-sub">{detail.row.cohortId ?? 'no cohort'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Contact</div>
          <div className="stat-value">
            {detail.row.touchCount}
            <span className="dim" style={{ fontSize: 13 }}>
              {' '}
              touches
            </span>
          </div>
          <div className="stat-sub">
            {detail.decisionCount} decisions · {detail.row.attemptCount} attempts
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Timeline</span>
          <span className="panel-hint">
            {detail.timeline.length} events · customer {detail.customerRef} · {detail.portfolio}
          </span>
        </div>
        <div className="panel-body">
          <div className="timeline">
            {detail.timeline.map((entry, index) => (
              <div className="tl-item" key={`${entry.kind}-${entry.at}-${index}`}>
                <span
                  className="tl-node"
                  style={{ background: TONE_COLOUR[entry.tone] }}
                  aria-hidden
                />
                {entry.payload === undefined ? (
                  <div style={{ display: 'flex', gap: 12, padding: '3px 0' }}>
                    <span className="num dim" style={{ minWidth: 122, fontSize: 11 }}>
                      {stamp(entry.at)}
                    </span>
                    <span className="num" style={{ minWidth: 88, fontSize: 11, opacity: 0.75 }}>
                      {entry.kind}
                    </span>
                    <span style={{ minWidth: 220 }}>{entry.headline}</span>
                    <span className="dim">{entry.detail}</span>
                  </div>
                ) : (
                  <Disclosure
                    summary={
                      <div style={{ display: 'flex', gap: 12, padding: '3px 0' }}>
                        <span className="num dim" style={{ minWidth: 122, fontSize: 11 }}>
                          {stamp(entry.at)}
                        </span>
                        <span className="num" style={{ minWidth: 88, fontSize: 11, opacity: 0.75 }}>
                          <span className="caret">›</span> {entry.kind}
                        </span>
                        <span style={{ minWidth: 220, color: TONE_COLOUR[entry.tone] }}>
                          {entry.headline}
                        </span>
                        <span className="dim">{entry.detail}</span>
                      </div>
                    }
                  >
                    <div
                      style={{
                        padding: '10px 12px',
                        marginTop: 4,
                        background: 'var(--surface-2)',
                        border: '1px solid var(--line)',
                        borderRadius: 4,
                      }}
                    >
                      <DecisionTrace payload={entry.payload} />
                    </div>
                  </Disclosure>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
