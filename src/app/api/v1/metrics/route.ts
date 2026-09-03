import { NextResponse } from 'next/server'

import { measurement } from '../../../lib/console-data'
import { requireApiKey } from '../../auth'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  const denied = requireApiKey(request)
  if (denied !== undefined) return denied

  const result = await measurement()

  return NextResponse.json({
    incrementalRecoveredFraction: result.incrementalRecoveredFraction,
    incrementalPerCasePaise: result.incrementalPerCasePaise,
    incrementalNetValuePerCasePaise: result.incrementalNetValuePerCasePaise,
    arms: {
      treatment: {
        cases: result.treatment.cases,
        recovered: result.treatment.recovered,
        recoveryRate: result.treatment.recoveryRate,
        touches: result.treatment.touches,
        optOuts: result.treatment.optOuts,
      },
      control: {
        cases: result.control.cases,
        recovered: result.control.recovered,
        recoveryRate: result.control.recoveryRate,
        touches: result.control.touches,
        optOuts: result.control.optOuts,
      },
    },
    harm: {
      policyViolations: result.policyViolations,
      falseDunningContacts: result.treatment.falseDunningContacts,
      overContactIncidents: result.treatment.overContactIncidents,
      deadLetteredActions: result.deadLetteredActions,
    },
    integrity: {
      decisions: result.decisionCount,
      propensityCoverage: result.propensityCoverage,
      unmappedRate: result.unmappedRate,
    },
  })
}
