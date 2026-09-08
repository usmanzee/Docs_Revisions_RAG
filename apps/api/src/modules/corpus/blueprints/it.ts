/** Information Technology blueprints: incident management and backup/recovery. */

import {
  businessDays,
  choice,
  complianceSection,
  days,
  definitionsSection,
  exceptionsSection,
  fact,
  hours,
  minutes,
  months,
  percent,
  relatedDocumentsSection,
  responsibilitiesSection,
  type Blueprint,
} from './shared.js';

export const incidentManagementProcedure: Blueprint = {
  key: 'incident-management-procedure',
  codePrefix: 'IT-PROC',
  title: 'Production Incident Management Procedure',
  department: 'Information Technology',
  documentType: 'PROCEDURE',
  category: 'Service Management',
  ownerRole: 'Head of IT Operations',
  tags: ['incident', 'priority', 'escalation', 'major incident'],
  description:
    'Defines incident priorities, escalation timings, communication cadence and the post-incident review ' +
    'process for production services.',
  purpose:
    'This procedure defines how a production incident is raised, prioritised, escalated and resolved, so ' +
    'that response is consistent regardless of who is on call.',
  scope:
    'This procedure applies to every incident affecting a production service, including incidents raised by ' +
    'monitoring, by the service desk, or by a supplier.',

  facts: [
    fact('p1Escalation', 'P1 escalation deadline', 'priority-levels', minutes(10, 30, 5)),
    fact('p2Escalation', 'P2 escalation deadline', 'priority-levels', minutes(30, 120, 15)),
    fact('p1Response', 'P1 initial response time', 'priority-levels', minutes(5, 20, 5)),
    fact('p1Resolution', 'P1 target resolution', 'priority-levels', hours(2, 8)),
    fact('p2Resolution', 'P2 target resolution', 'priority-levels', hours(8, 24)),
    fact('p3Resolution', 'P3 target resolution', 'priority-levels', businessDays(2, 5)),
    fact('updateInterval', 'Major incident update cadence', 'communication', minutes(15, 60, 15)),
    fact('bridgeTime', 'Major incident bridge opening time', 'major-incident', minutes(5, 20, 5)),
    fact('pirDeadline', 'Post-incident review deadline', 'post-incident-review', businessDays(3, 10)),
    fact('actionDeadline', 'Remedial action completion', 'post-incident-review', days(14, 60)),
    fact('onCallAck', 'On-call acknowledgement time', 'on-call', minutes(5, 15, 5)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'priority-levels',
        title: 'Priority Levels and Response Targets',
        paragraphs: [
          `Incident priority is set from business impact and urgency at the point the incident is raised, ` +
            'and is reviewed at every status update. Priority may be raised or lowered as understanding ' +
            'improves, and the reason is recorded.',
          `A priority-one (P1) incident must be escalated to the on-call incident manager within ` +
            `${f('p1Escalation')} of detection. Initial response begins within ${f('p1Response')}, and the ` +
            `target resolution is ${f('p1Resolution')}.`,
          `A priority-two (P2) incident must be escalated within ${f('p2Escalation')}, with a target ` +
            `resolution of ${f('p2Resolution')}. Priority-three incidents target resolution within ` +
            `${f('p3Resolution')}.`,
        ],
        table: {
          caption: 'Incident priority matrix',
          header: ['Priority', 'Definition', 'Escalation within', 'Target resolution'],
          rows: [
            ['P1', 'Production service unavailable or data at risk', f('p1Escalation'), f('p1Resolution')],
            ['P2', 'Major function degraded, no workaround', f('p2Escalation'), f('p2Resolution')],
            ['P3', 'Function degraded, workaround available', '4 hours', f('p3Resolution')],
            ['P4', 'Minor issue or cosmetic defect', 'Next business day', '10 business days'],
          ],
        },
      },
      {
        key: 'on-call',
        title: 'On-Call Response',
        paragraphs: [
          `The on-call engineer must acknowledge a page within ${f('onCallAck')}. An unacknowledged page ` +
            'escalates automatically to the secondary on-call engineer and then to the duty manager.',
        ],
      },
      {
        key: 'major-incident',
        title: 'Major Incident Handling',
        paragraphs: [
          `A P1 incident is declared a major incident when it affects multiple services or an external ` +
            `customer commitment. The incident manager opens a bridge within ${f('bridgeTime')} of the ` +
            'declaration and appoints a communications lead.',
          'The incident manager owns the incident until it is resolved. Technical decisions remain with ' +
            'the engineers; the incident manager owns sequencing, communication and escalation.',
        ],
        steps: [
          'Declare the major incident and record the declaration time.',
          'Open the incident bridge and appoint an incident manager and a communications lead.',
          'Establish impact: affected services, affected customers, and whether data is at risk.',
          'Agree and apply a mitigation, preferring service restoration over root-cause analysis.',
          'Confirm restoration with the service owner and monitoring before standing down.',
          'Record the timeline while it is fresh, then close the bridge.',
        ],
      },
      {
        key: 'communication',
        title: 'Communication',
        paragraphs: [
          `During a major incident, a status update is issued every ${f('updateInterval')} even when there ` +
            'is nothing new to report. Silence is interpreted by stakeholders as loss of control.',
          'Updates state what is known, what is being done, what is not yet known, and the time of the ' +
            'next update. Speculation about cause is not included in customer-facing updates.',
        ],
      },
      {
        key: 'post-incident-review',
        title: 'Post-Incident Review',
        paragraphs: [
          `A post-incident review is held for every P1 and for any P2 that breached its resolution target. ` +
            `The review takes place within ${f('pirDeadline')} of resolution.`,
          `Remedial actions are assigned to a named owner with a completion date no later than ` +
            `${f('actionDeadline')} after the review. Actions are tracked to closure in the service ` +
            'management system.',
          'Reviews are blameless. The purpose is to find the conditions that allowed the failure, not the ' +
            'individual who was closest to it.',
        ],
      },
      definitionsSection([
        ['Incident', 'an unplanned interruption or reduction in quality of a production service'],
        ['Major incident', 'a P1 affecting multiple services or an external customer commitment'],
        ['Workaround', 'a temporary means of restoring service without addressing the underlying cause'],
        ['Incident manager', 'the person accountable for coordination and communication during an incident'],
      ]),
      responsibilitiesSection([
        ['On-Call Engineer', 'Acknowledges pages within the stated time and performs initial diagnosis'],
        ['Incident Manager', 'Owns coordination, escalation and communication for major incidents'],
        ['Service Owner', 'Confirms restoration and accepts remedial actions'],
        ['Service Desk', 'Raises incidents, applies initial priority and keeps the record current'],
      ]),
      exceptionsSection('Head of IT Operations', 'the duration of the incident'),
      complianceSection('annually', 'Head of IT Operations'),
      relatedDocumentsSection([
        'Backup and Recovery Procedure',
        'Oracle Database Performance Guidelines',
        'Change Management Standard',
      ]),
    ];
  },

  workflow(context) {
    const { f } = context;
    return {
      title: 'Production incident escalation workflow',
      nodes: [
        'Incident Detected',
        'Service Desk Triage',
        `Priority Assigned (P1 within ${f('p1Escalation')})`,
        'On-Call Engineer Engaged',
        'Incident Manager Escalation',
        'Mitigation Applied',
        'Service Restored',
        'Post-Incident Review',
      ],
      expectedText:
        'Incident Detected -> Service Desk Triage -> Priority Assigned -> On-Call Engineer Engaged -> ' +
        'Incident Manager Escalation -> Mitigation Applied -> Service Restored -> Post-Incident Review',
    };
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'When must a priority-one incident be escalated?',
        sectionKey: 'priority-levels',
        factIds: ['p1Escalation'],
        referenceAnswer: `A P1 incident must be escalated to the on-call incident manager within ${f('p1Escalation')} of detection.`,
      },
      {
        type: 'PARAPHRASE',
        question: 'How quickly does a P1 have to be raised to the incident manager?',
        sectionKey: 'priority-levels',
        factIds: ['p1Escalation'],
        referenceAnswer: `Within ${f('p1Escalation')} of detection.`,
      },
      {
        type: 'DIRECT',
        question: 'How often are status updates issued during a major incident?',
        sectionKey: 'communication',
        factIds: ['updateInterval'],
        referenceAnswer: `A status update is issued every ${f('updateInterval')}, even when there is nothing new to report.`,
      },
      {
        type: 'DIRECT',
        question: 'When must a post-incident review be held?',
        sectionKey: 'post-incident-review',
        factIds: ['pirDeadline'],
        referenceAnswer: `The review takes place within ${f('pirDeadline')} of resolution, for every P1 and any P2 that breached its target.`,
      },
      {
        type: 'CROSS_SECTION',
        question: 'What is the target resolution time for a P1 and when is the review held afterwards?',
        sectionKey: 'priority-levels',
        factIds: ['p1Resolution', 'pirDeadline'],
        referenceAnswer: `The P1 target resolution is ${f('p1Resolution')}, and a post-incident review is held within ${f('pirDeadline')} of resolution.`,
      },
    ];
  },
};

export const backupRecoveryProcedure: Blueprint = {
  key: 'backup-recovery-procedure',
  codePrefix: 'IT-PROC',
  title: 'Backup and Recovery Procedure',
  department: 'Information Technology',
  documentType: 'PROCEDURE',
  category: 'Data Protection',
  ownerRole: 'Head of Infrastructure',
  tags: ['backup', 'recovery', 'retention', 'restore testing'],
  description:
    'Defines backup schedules, retention periods, offsite copies, restore testing and the recovery ' +
    'objectives that apply to production systems.',
  purpose:
    'This procedure defines how production data is backed up, how long backups are retained, and how ' +
    'restores are tested and performed.',
  scope:
    'This procedure applies to all production systems and to any non-production system holding a copy of ' +
    'production data.',

  facts: [
    fact('fullBackupDay', 'Full backup schedule', 'schedule', choice(['Saturday', 'Sunday'])),
    fact('incrementalFrequency', 'Incremental backup frequency', 'schedule', hours(1, 12)),
    fact('productionRetention', 'Production backup retention', 'retention', days(30, 120)),
    fact('monthlyRetention', 'Monthly archive retention', 'retention', months(12, 84)),
    fact('offsiteDelay', 'Offsite replication window', 'offsite', hours(2, 24)),
    fact('rpo', 'Recovery point objective', 'recovery-objectives', minutes(15, 120, 15)),
    fact('rto', 'Recovery time objective', 'recovery-objectives', hours(2, 12)),
    fact('restoreTestFrequency', 'Restore test frequency', 'restore-testing', months(1, 6)),
    fact('restoreTestSample', 'Restore test coverage', 'restore-testing', percent(10, 40, 5)),
    fact('encryptionRequirement', 'Backup encryption', 'security', choice(['AES-256 at rest and in transit'])),
    fact('immutableWindow', 'Immutable backup window', 'security', days(7, 35)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'schedule',
        title: 'Backup Schedule',
        paragraphs: [
          `A full backup of every production system is taken weekly on ${f('fullBackupDay')}. Incremental ` +
            `backups run every ${f('incrementalFrequency')} between full backups.`,
          'Backup jobs that fail are retried automatically once. A second failure raises a P2 incident and ' +
            'is investigated before the next scheduled run.',
        ],
        table: {
          caption: 'Backup schedule by tier',
          header: ['System tier', 'Full backup', 'Incremental', 'Retention'],
          rows: [
            ['Tier 1 - production', `Weekly (${f('fullBackupDay')})`, f('incrementalFrequency'), f('productionRetention')],
            ['Tier 2 - internal', 'Weekly', 'Daily', '30 days'],
            ['Tier 3 - development', 'Monthly', 'None', '14 days'],
          ],
        },
      },
      {
        key: 'retention',
        title: 'Retention',
        paragraphs: [
          `Production backups are retained for ${f('productionRetention')}. The final full backup of each ` +
            `month is promoted to a monthly archive and retained for ${f('monthlyRetention')}.`,
          'Retention is enforced by the backup platform. Manual deletion of a backup before its retention ' +
            'expiry requires Head of Infrastructure approval and is recorded.',
        ],
      },
      {
        key: 'offsite',
        title: 'Offsite Copies',
        paragraphs: [
          `Every backup is replicated to the secondary region within ${f('offsiteDelay')} of completion. ` +
            'A backup that exists in only one region does not satisfy this procedure.',
        ],
      },
      {
        key: 'recovery-objectives',
        title: 'Recovery Objectives',
        paragraphs: [
          `The recovery point objective for tier-one production systems is ${f('rpo')}, and the recovery ` +
            `time objective is ${f('rto')}. These objectives drive the incremental backup frequency rather ` +
            'than the other way round.',
        ],
      },
      {
        key: 'restore-testing',
        title: 'Restore Testing',
        paragraphs: [
          `A restore test is performed every ${f('restoreTestFrequency')}, covering at least ` +
            `${f('restoreTestSample')} of tier-one systems on a rotating basis. A backup that has never ` +
            'been restored is not evidence of recoverability.',
          'Each test records the time to restore, the data loss observed against the recovery point ' +
            'objective, and any manual steps required.',
        ],
        steps: [
          'Select the systems in scope for this cycle from the rotation schedule.',
          'Restore the most recent full backup and the applicable incrementals to an isolated environment.',
          'Validate application start-up and run the documented data integrity checks.',
          'Record the elapsed restore time and compare it against the recovery time objective.',
          'Raise remedial actions for any objective that was not met and track them to closure.',
        ],
      },
      {
        key: 'security',
        title: 'Backup Security',
        paragraphs: [
          `Backups are encrypted using ${f('encryptionRequirement')}. Encryption keys are held in the key ` +
            'management service and are never stored alongside the backup data.',
          `Backups are immutable for ${f('immutableWindow')} after creation so that a compromised ` +
            'administrative account cannot destroy the organisation’s ability to recover.',
        ],
      },
      responsibilitiesSection([
        ['Infrastructure Team', 'Operates backup schedules and investigates failures'],
        ['System Owner', 'Confirms recovery objectives and participates in restore tests'],
        ['Head of Infrastructure', 'Approves early deletion and owns this procedure'],
        ['Information Security', 'Defines encryption and immutability requirements'],
      ]),
      exceptionsSection('Head of Infrastructure', 'three months'),
      relatedDocumentsSection([
        'Oracle Backup and Recovery Guidelines',
        'Production Incident Management Procedure',
        'Disaster Recovery Standard',
      ]),
    ];
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'How long are production backups retained?',
        sectionKey: 'retention',
        factIds: ['productionRetention'],
        referenceAnswer: `Production backups are retained for ${f('productionRetention')}, with monthly archives kept for ${f('monthlyRetention')}.`,
      },
      {
        type: 'TERMINOLOGY',
        question: 'What is the recovery point objective for tier-one production systems?',
        sectionKey: 'recovery-objectives',
        factIds: ['rpo'],
        referenceAnswer: `The recovery point objective for tier-one production systems is ${f('rpo')}.`,
      },
      {
        type: 'DIRECT',
        question: 'How often are restore tests performed?',
        sectionKey: 'restore-testing',
        factIds: ['restoreTestFrequency'],
        referenceAnswer: `A restore test is performed every ${f('restoreTestFrequency')}, covering at least ${f('restoreTestSample')} of tier-one systems.`,
      },
      {
        type: 'DIRECT',
        question: 'When are full backups taken?',
        sectionKey: 'schedule',
        factIds: ['fullBackupDay'],
        referenceAnswer: `A full backup of every production system is taken weekly on ${f('fullBackupDay')}.`,
      },
    ];
  },
};

export const itBlueprints: Blueprint[] = [incidentManagementProcedure, backupRecoveryProcedure];
