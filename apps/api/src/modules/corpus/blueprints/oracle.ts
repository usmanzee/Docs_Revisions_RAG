/**
 * Database Administration blueprints - the Oracle guidance family.
 *
 * Ordering matters: the generator assigns codes sequentially per prefix, so the
 * order of `oracleBlueprints` fixes ORA-GUIDE-001 through ORA-GUIDE-005. The
 * tablespace guideline is ORA-GUIDE-003, which is the document the identifier
 * retrieval scenario asks about.
 */

import {
  businessDays,
  choice,
  complianceSection,
  count,
  days,
  definitionsSection,
  exceptionsSection,
  fact,
  hours,
  minutes,
  months,
  ORACLE_VERSIONS,
  percent,
  relatedDocumentsSection,
  responsibilitiesSection,
  type Blueprint,
} from './shared.js';

export const oraclePerformanceGuidelines: Blueprint = {
  key: 'oracle-performance-guidelines',
  codePrefix: 'ORA-GUIDE',
  title: 'Oracle Database Performance Guidelines',
  department: 'Database Administration',
  documentType: 'TECHNICAL_GUIDE',
  category: 'Oracle Database',
  ownerRole: 'Lead Database Administrator',
  tags: ['oracle', 'performance', 'awr', 'sga', 'tuning'],
  description:
    'Baseline performance configuration and diagnostic practice for production Oracle databases, including ' +
    'memory sizing, AWR retention and statistics collection.',
  purpose:
    'These guidelines define the baseline performance configuration expected of a production Oracle ' +
    'database and the diagnostic steps to follow when performance degrades.',
  scope:
    'These guidelines apply to all production and pre-production Oracle databases operated by the Database ' +
    'Administration team.',

  facts: [
    fact('oracleVersion', 'Supported Oracle release', 'baseline', choice(ORACLE_VERSIONS)),
    fact('sgaTarget', 'Minimum SGA target for production', 'baseline', count(16, 96, 'GB')),
    fact('pgaTarget', 'PGA aggregate target', 'baseline', count(4, 32, 'GB')),
    fact('awrRetention', 'AWR snapshot retention', 'diagnostics', days(14, 60)),
    fact('awrInterval', 'AWR snapshot interval', 'diagnostics', minutes(15, 60, 15)),
    fact('statsStaleness', 'Statistics staleness threshold', 'statistics', percent(5, 20, 1)),
    fact('statsWindow', 'Statistics gathering window', 'statistics', hours(2, 8)),
    fact('cursorSharing', 'Cursor sharing setting', 'baseline', choice(['EXACT'])),
    fact('longQueryThreshold', 'Long-running query alert threshold', 'diagnostics', minutes(5, 30, 5)),
    fact('reviewCycle', 'Performance review cadence', 'review', months(1, 6)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'baseline',
        title: 'Baseline Configuration',
        paragraphs: [
          `Production databases run on Oracle ${f('oracleVersion')}. Automatic memory management is not ` +
            `used; SGA and PGA are sized explicitly, with a minimum SGA target of ${f('sgaTarget')} and a ` +
            `PGA aggregate target of ${f('pgaTarget')} for a production instance.`,
          `CURSOR_SHARING is left at ${f('cursorSharing')}. Changing it to FORCE masks application-side ` +
            'literal usage and moves the problem into the shared pool rather than solving it.',
        ],
        table: {
          caption: 'Baseline instance parameters',
          header: ['Parameter', 'Production value', 'Rationale'],
          rows: [
            ['SGA_TARGET', `at least ${f('sgaTarget')}`, 'Buffer cache and shared pool sizing'],
            ['PGA_AGGREGATE_TARGET', f('pgaTarget'), 'Sort and hash workarea memory'],
            ['CURSOR_SHARING', f('cursorSharing'), 'Preserve plan stability'],
            ['OPTIMIZER_ADAPTIVE_PLANS', 'TRUE', 'Allow plan correction at execution time'],
          ],
        },
      },
      {
        key: 'diagnostics',
        title: 'Diagnostics and Monitoring',
        paragraphs: [
          `AWR snapshots are taken every ${f('awrInterval')} and retained for ${f('awrRetention')}, which ` +
            'is long enough to compare a degraded period against the equivalent period in previous weeks.',
          `An alert is raised for any query running longer than ${f('longQueryThreshold')} on a production ` +
            'instance. The alert includes the SQL identifier so the plan can be retrieved directly.',
        ],
        steps: [
          'Confirm the problem is database-side by checking application and network latency first.',
          'Generate an AWR report covering the degraded interval and a healthy comparison interval.',
          'Review top foreground wait events before looking at individual SQL statements.',
          'Identify the SQL identifiers responsible for the largest elapsed time, not the largest count.',
          'Retrieve the execution plan and compare it against the plan from the healthy interval.',
          'Apply the smallest safe correction - statistics, an index, or a SQL plan baseline.',
        ],
      },
      {
        key: 'statistics',
        title: 'Optimizer Statistics',
        paragraphs: [
          `Statistics are gathered automatically in a maintenance window of ${f('statsWindow')}. A table ` +
            `whose modified rows exceed ${f('statsStaleness')} of its total rows is considered stale and is ` +
            'included in the next gathering run.',
          'Statistics are never gathered on a production instance during business hours without an ' +
            'approved change, because the resulting plan changes are not predictable.',
        ],
      },
      {
        key: 'review',
        title: 'Performance Review',
        paragraphs: [
          `The Database Administration team reviews performance trends every ${f('reviewCycle')}, ` +
            'comparing wait event profiles and top SQL against the previous period.',
        ],
      },
      definitionsSection([
        ['AWR', 'Automatic Workload Repository, the built-in performance history store'],
        ['SGA', 'System Global Area, the shared memory region used by an Oracle instance'],
        ['Stale statistics', 'optimizer statistics that no longer reflect the data distribution'],
      ]),
      responsibilitiesSection([
        ['Database Administrator', 'Maintains baseline configuration and investigates performance alerts'],
        ['Application Team', 'Provides representative workload detail and owns application-side SQL'],
        ['Change Manager', 'Approves parameter changes on production instances'],
      ]),
      exceptionsSection('Lead Database Administrator', 'one release cycle'),
      complianceSection('annually', 'Lead Database Administrator'),
      relatedDocumentsSection([
        'Oracle Backup and Recovery Guidelines',
        'Oracle Tablespace Management Guidelines',
        'Production Incident Management Procedure',
      ]),
    ];
  },

  questions(context) {
    const { f, documentCode } = context;
    return [
      {
        type: 'DIRECT',
        question: 'How long are AWR snapshots retained on production databases?',
        sectionKey: 'diagnostics',
        factIds: ['awrRetention'],
        referenceAnswer: `AWR snapshots are retained for ${f('awrRetention')} and taken every ${f('awrInterval')}.`,
      },
      {
        type: 'IDENTIFIER',
        question: `What SGA target does ${documentCode} require for a production instance?`,
        sectionKey: 'baseline',
        factIds: ['sgaTarget'],
        referenceAnswer: `${documentCode} requires a minimum SGA target of ${f('sgaTarget')} for a production instance.`,
      },
      {
        type: 'TERMINOLOGY',
        question: 'What CURSOR_SHARING setting is required on production Oracle databases?',
        sectionKey: 'baseline',
        factIds: ['cursorSharing'],
        referenceAnswer: `CURSOR_SHARING is left at ${f('cursorSharing')}.`,
      },
      {
        type: 'DIRECT',
        question: 'At what point are optimizer statistics considered stale?',
        sectionKey: 'statistics',
        factIds: ['statsStaleness'],
        referenceAnswer: `A table whose modified rows exceed ${f('statsStaleness')} of its total rows is considered stale.`,
      },
    ];
  },
};

export const oracleBackupGuidelines: Blueprint = {
  key: 'oracle-backup-guidelines',
  codePrefix: 'ORA-GUIDE',
  title: 'Oracle Backup and Recovery Guidelines',
  department: 'Database Administration',
  documentType: 'TECHNICAL_GUIDE',
  category: 'Oracle Database',
  ownerRole: 'Lead Database Administrator',
  tags: ['oracle', 'rman', 'backup', 'recovery', 'retention'],
  description:
    'RMAN backup strategy, retention policy, archive log management and recovery validation for production ' +
    'Oracle databases.',
  purpose:
    'These guidelines define how production Oracle databases are backed up with RMAN, how long those ' +
    'backups are retained, and how recoverability is proven.',
  scope: 'These guidelines apply to all production Oracle databases and their standby instances.',

  facts: [
    fact('retentionDays', 'Production backup retention', 'retention-policy', days(14, 45)),
    fact('archiveRetention', 'Archive log retention', 'archive-logs', days(7, 30)),
    fact('level0Day', 'Level 0 backup day', 'backup-strategy', choice(['Sunday', 'Saturday'])),
    fact('level1Frequency', 'Level 1 incremental frequency', 'backup-strategy', choice(['daily', 'twice daily'])),
    fact('archiveBackupInterval', 'Archive log backup interval', 'archive-logs', hours(1, 6)),
    fact('redundancy', 'Backup redundancy', 'retention-policy', count(2, 4, 'copies')),
    fact('validateFrequency', 'RMAN validate frequency', 'validation', months(1, 3)),
    fact('recoveryDrill', 'Full recovery drill frequency', 'validation', months(3, 12)),
    fact('flashbackWindow', 'Flashback retention target', 'flashback', hours(24, 72)),
    fact('rmanParallelism', 'RMAN channel parallelism', 'backup-strategy', count(2, 8, 'channels')),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'backup-strategy',
        title: 'Backup Strategy',
        paragraphs: [
          `A level 0 incremental backup is taken weekly on ${f('level0Day')}, with level 1 differential ` +
            `incrementals ${f('level1Frequency')}. Backups run with ${f('rmanParallelism')} of RMAN ` +
            'parallelism to fit the maintenance window.',
          'Block change tracking is enabled on every production database so that level 1 incrementals read ' +
            'only changed blocks rather than scanning the whole datafile.',
        ],
      },
      {
        key: 'retention-policy',
        title: 'Retention Policy',
        paragraphs: [
          `The RMAN retention policy is set to a recovery window of ${f('retentionDays')}. Production ` +
            `Oracle backups are retained for ${f('retentionDays')} before they become obsolete.`,
          `In addition to the recovery window, ${f('redundancy')} of the most recent level 0 backup are ` +
            'kept, so a single corrupt backup piece does not eliminate recoverability.',
          'Obsolete backups are deleted only by the scheduled maintenance job. Manual deletion on a ' +
            'production database requires an approved change.',
        ],
        table: {
          caption: 'RMAN retention configuration',
          header: ['Setting', 'Value', 'Purpose'],
          rows: [
            ['RECOVERY WINDOW', f('retentionDays'), 'Point-in-time recovery horizon'],
            ['REDUNDANCY', f('redundancy'), 'Protection against a corrupt backup piece'],
            ['ARCHIVELOG DELETION POLICY', `applied after ${f('archiveRetention')}`, 'Prevents premature log removal'],
          ],
        },
      },
      {
        key: 'archive-logs',
        title: 'Archive Log Management',
        paragraphs: [
          `Archive logs are backed up every ${f('archiveBackupInterval')} and retained for ` +
            `${f('archiveRetention')}. Logs are deleted only after they have been backed up and applied to ` +
            'every standby database.',
          'A full fast recovery area is the most common cause of a production database halting. Free space ' +
            'is monitored and alerted on before it becomes an incident.',
        ],
      },
      {
        key: 'validation',
        title: 'Backup Validation',
        paragraphs: [
          `RMAN VALIDATE is run against the most recent backup set every ${f('validateFrequency')} to ` +
            'confirm the backup pieces are readable and free of block corruption.',
          `A full recovery drill - restoring a production database to an isolated environment and opening ` +
            `it - is performed every ${f('recoveryDrill')}. The elapsed time is recorded and compared ` +
            'against the recovery time objective.',
        ],
        steps: [
          'Restore the most recent level 0 backup to the recovery test environment.',
          'Apply level 1 incrementals and the archive logs required to reach the target point in time.',
          'Open the database with RESETLOGS in the isolated environment.',
          'Run the documented data integrity checks against key application tables.',
          'Record elapsed restore time, data loss against the recovery point objective, and any manual steps.',
        ],
      },
      {
        key: 'flashback',
        title: 'Flashback',
        paragraphs: [
          `Flashback database is enabled with a retention target of ${f('flashbackWindow')}, which allows a ` +
            'logical error to be reversed without a full restore.',
          'Flashback is a complement to backups, never a replacement: it does not protect against media ' +
            'failure or loss of the storage array.',
        ],
      },
      responsibilitiesSection([
        ['Database Administrator', 'Operates RMAN schedules and investigates backup failures'],
        ['Lead Database Administrator', 'Owns retention configuration and approves manual deletion'],
        ['Infrastructure Team', 'Provides and monitors fast recovery area capacity'],
      ]),
      exceptionsSection('Lead Database Administrator', 'one maintenance cycle'),
      relatedDocumentsSection([
        'Backup and Recovery Procedure',
        'Oracle Database Performance Guidelines',
        'Oracle Tablespace Management Guidelines',
      ]),
    ];
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'How long are Oracle production backups retained?',
        sectionKey: 'retention-policy',
        factIds: ['retentionDays'],
        referenceAnswer: `Production Oracle backups are retained for ${f('retentionDays')}, configured as an RMAN recovery window.`,
      },
      {
        type: 'DIRECT',
        question: 'How often are archive logs backed up?',
        sectionKey: 'archive-logs',
        factIds: ['archiveBackupInterval'],
        referenceAnswer: `Archive logs are backed up every ${f('archiveBackupInterval')} and retained for ${f('archiveRetention')}.`,
      },
      {
        type: 'DIRECT',
        question: 'How often is a full Oracle recovery drill performed?',
        sectionKey: 'validation',
        factIds: ['recoveryDrill'],
        referenceAnswer: `A full recovery drill is performed every ${f('recoveryDrill')}.`,
      },
      {
        type: 'TERMINOLOGY',
        question: 'What is the flashback database retention target?',
        sectionKey: 'flashback',
        factIds: ['flashbackWindow'],
        referenceAnswer: `Flashback database is enabled with a retention target of ${f('flashbackWindow')}.`,
      },
    ];
  },
};

export const oracleTablespaceGuidelines: Blueprint = {
  key: 'oracle-tablespace-guidelines',
  codePrefix: 'ORA-GUIDE',
  title: 'Oracle Tablespace Management Guidelines',
  department: 'Database Administration',
  documentType: 'TECHNICAL_GUIDE',
  category: 'Oracle Database',
  ownerRole: 'Lead Database Administrator',
  tags: ['oracle', 'tablespace', 'monitoring', 'autoextend', 'capacity'],
  description:
    'Tablespace sizing, autoextend configuration, monitoring thresholds and the response required when a ' +
    'tablespace approaches capacity.',
  purpose:
    'These guidelines define how tablespaces are created, sized, monitored and extended, so that a database ' +
    'never stops accepting writes because of avoidable space exhaustion.',
  scope: 'These guidelines apply to all permanent, temporary and undo tablespaces on managed Oracle databases.',

  facts: [
    fact('warningThreshold', 'Tablespace warning threshold', 'monitoring', percent(75, 88, 1)),
    fact('criticalThreshold', 'Tablespace critical threshold', 'monitoring', percent(90, 97, 1)),
    fact('checkFrequency', 'Tablespace check frequency', 'monitoring', minutes(15, 60, 15)),
    fact('autoextendIncrement', 'Autoextend increment', 'autoextend', count(128, 1024, 'MB')),
    fact('maxDatafileSize', 'Maximum datafile size', 'autoextend', count(16, 32, 'GB')),
    fact('initialExtent', 'Initial extent size', 'creation', count(1, 16, 'MB')),
    fact('capacityHorizon', 'Capacity planning horizon', 'capacity-planning', months(3, 18)),
    fact('growthReview', 'Growth review cadence', 'capacity-planning', months(1, 6)),
    fact('criticalResponse', 'Critical alert response time', 'monitoring', minutes(15, 60, 15)),
    fact('tempMonitor', 'Temporary tablespace alert threshold', 'temporary-undo', percent(80, 95, 1)),
    fact('undoRetention', 'Undo retention target', 'temporary-undo', minutes(15, 180, 15)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'creation',
        title: 'Tablespace Creation',
        paragraphs: [
          `New tablespaces are created as locally managed with automatic segment space management, and an ` +
            `initial extent of ${f('initialExtent')}. Dictionary-managed tablespaces are not created under ` +
            'any circumstances.',
          'Application data is never placed in SYSTEM or SYSAUX. A new application receives its own ' +
            'tablespace so that its growth can be attributed and managed independently.',
        ],
      },
      {
        key: 'monitoring',
        title: 'Monitoring and Alert Thresholds',
        paragraphs: [
          `Tablespace utilisation is checked every ${f('checkFrequency')}. A warning alert is raised at ` +
            `${f('warningThreshold')} utilisation, and a critical alert is raised at ` +
            `${f('criticalThreshold')} utilisation.`,
          `A critical tablespace alert must be acknowledged and acted on within ${f('criticalResponse')}. ` +
            'A tablespace that reaches 100% utilisation causes application write failures and is treated ' +
            'as a priority-one incident.',
          'Monitoring measures utilisation against maximum possible size, including autoextend headroom - ' +
            'not against currently allocated size, which would report a healthy figure right up to the ' +
            'moment the datafile stops growing.',
        ],
        table: {
          caption: 'Tablespace monitoring thresholds',
          header: ['Condition', 'Threshold', 'Response'],
          rows: [
            [
              'Warning',
              `${f('warningThreshold')} of maximum size`,
              'Raise a low-priority ticket and plan an extension',
            ],
            [
              'Critical',
              `${f('criticalThreshold')} of maximum size`,
              `Act within ${f('criticalResponse')} and add space`,
            ],
            ['Exhausted', '100% of maximum size', 'Raise a P1 incident - writes are failing'],
            [
              'Temporary tablespace',
              `${f('tempMonitor')} of maximum size`,
              'Investigate long-running sorts before adding space',
            ],
          ],
        },
      },
      {
        key: 'autoextend',
        title: 'Autoextend Configuration',
        paragraphs: [
          `Datafiles are created with autoextend enabled, an increment of ${f('autoextendIncrement')}, and ` +
            `an explicit MAXSIZE of ${f('maxDatafileSize')}. AUTOEXTEND with MAXSIZE UNLIMITED is not ` +
            'permitted, because it converts a database space problem into a filesystem outage that affects ' +
            'every database on the host.',
          'Adding a datafile is preferred over raising MAXSIZE beyond the standard, so that growth remains ' +
            'visible and attributable.',
        ],
        steps: [
          'Confirm the alert reflects real growth rather than a one-off bulk load that has since completed.',
          'Check free space in the underlying storage before extending anything.',
          'Add a datafile at the standard size, or raise MAXSIZE only where the standard has been reviewed.',
          'Record the change and update the growth trend for the affected application.',
          'Where growth is unexpected, refer it to the application team before adding further space.',
        ],
      },
      {
        key: 'temporary-undo',
        title: 'Temporary and Undo Tablespaces',
        paragraphs: [
          `Temporary tablespace usage is alerted at ${f('tempMonitor')}. Sustained high usage normally ` +
            'indicates a query performing a large sort or hash join, and is investigated as a performance ' +
            'problem rather than a capacity problem.',
          `Undo retention is targeted at ${f('undoRetention')} to support long-running reports without ` +
            'ORA-01555 snapshot-too-old errors.',
        ],
      },
      {
        key: 'capacity-planning',
        title: 'Capacity Planning',
        paragraphs: [
          `Growth is reviewed every ${f('growthReview')} and projected over a ${f('capacityHorizon')} ` +
            'horizon. Storage is requested when the projection shows exhaustion inside the horizon, not ' +
            'when the critical alert fires.',
        ],
      },
      definitionsSection([
        ['Autoextend', 'the datafile setting allowing automatic growth up to a maximum size'],
        ['Maximum size', 'the largest size a datafile may reach, used as the denominator for utilisation'],
        ['ORA-01555', 'the snapshot-too-old error raised when undo required by a long query has been reused'],
      ]),
      responsibilitiesSection([
        ['Database Administrator', 'Responds to tablespace alerts and extends space within standards'],
        ['Application Team', 'Explains unexpected growth and owns data lifecycle in its own tablespaces'],
        ['Infrastructure Team', 'Provides underlying storage capacity ahead of projected need'],
      ]),
      exceptionsSection('Lead Database Administrator', 'one capacity review cycle'),
      relatedDocumentsSection([
        'Oracle Database Performance Guidelines',
        'Oracle Backup and Recovery Guidelines',
        'Oracle Listener Troubleshooting Guide',
      ]),
    ];
  },

  questions(context) {
    const { f, documentCode } = context;
    return [
      {
        type: 'IDENTIFIER',
        question: `What does ${documentCode} recommend regarding tablespace monitoring?`,
        sectionKey: 'monitoring',
        factIds: ['warningThreshold', 'criticalThreshold', 'checkFrequency'],
        referenceAnswer: `${documentCode} requires tablespace utilisation to be checked every ${f('checkFrequency')}, with a warning alert at ${f('warningThreshold')} and a critical alert at ${f('criticalThreshold')} of maximum size.`,
      },
      {
        type: 'DIRECT',
        question: 'At what utilisation is a critical tablespace alert raised?',
        sectionKey: 'monitoring',
        factIds: ['criticalThreshold'],
        referenceAnswer: `A critical alert is raised at ${f('criticalThreshold')} utilisation.`,
      },
      {
        type: 'DIRECT',
        question: 'What maximum datafile size is used for autoextend?',
        sectionKey: 'autoextend',
        factIds: ['maxDatafileSize'],
        referenceAnswer: `Datafiles are created with an explicit MAXSIZE of ${f('maxDatafileSize')}; MAXSIZE UNLIMITED is not permitted.`,
      },
      {
        type: 'PARAPHRASE',
        question: 'Is unlimited autoextend allowed on datafiles?',
        sectionKey: 'autoextend',
        factIds: [],
        referenceAnswer:
          'No. AUTOEXTEND with MAXSIZE UNLIMITED is not permitted because it turns a database space problem into a filesystem outage.',
      },
      {
        type: 'CROSS_SECTION',
        question: 'What undo retention is targeted and why does it matter for long reports?',
        sectionKey: 'temporary-undo',
        factIds: ['undoRetention'],
        referenceAnswer: `Undo retention is targeted at ${f('undoRetention')} to support long-running reports without ORA-01555 snapshot-too-old errors.`,
      },
    ];
  },
};

export const oracleListenerTroubleshooting: Blueprint = {
  key: 'oracle-listener-troubleshooting',
  codePrefix: 'ORA-GUIDE',
  title: 'Oracle Listener Troubleshooting Guide',
  department: 'Database Administration',
  documentType: 'TECHNICAL_GUIDE',
  category: 'Oracle Database',
  ownerRole: 'Lead Database Administrator',
  tags: ['oracle', 'listener', 'tns', 'connectivity', 'troubleshooting'],
  description:
    'Diagnostic sequence for Oracle listener and TNS connectivity failures, including the common error ' +
    'numbers and their usual causes.',
  purpose:
    'This guide provides a repeatable diagnostic sequence for connection failures to an Oracle database, so ' +
    'that engineers do not restart services speculatively.',
  scope: 'This guide applies to listener and client connectivity issues on managed Oracle databases.',

  facts: [
    fact('listenerPort', 'Standard listener port', 'configuration', choice(['1521', '1522', '1531'])),
    fact('connectTimeout', 'Inbound connect timeout', 'configuration', count(30, 120, 'seconds')),
    fact('retryCount', 'Client retry count', 'configuration', count(2, 5, 'attempts')),
    fact('logRetention', 'Listener log retention', 'logs', days(14, 60)),
    fact('registrationInterval', 'Instance registration interval', 'registration', count(30, 120, 'seconds')),
    fact('escalationTime', 'Escalation to DBA lead', 'escalation', minutes(20, 60, 10)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'common-errors',
        title: 'Common Errors',
        paragraphs: [
          'Most reported connectivity failures resolve to one of a small number of errors. Identify the ' +
            'exact error number before changing anything - the remediation differs sharply between them.',
        ],
        table: {
          caption: 'Common connectivity errors',
          header: ['Error', 'Meaning', 'Usual cause'],
          rows: [
            ['ORA-12154', 'TNS could not resolve the connect identifier', 'Client tnsnames.ora entry missing or misspelled'],
            ['ORA-12514', 'Listener does not know of the requested service', 'Instance not registered with the listener'],
            ['ORA-12541', 'No listener', 'Listener process is down or the wrong port was used'],
            ['ORA-12170', 'Connect timeout occurred', 'Network path blocked by a firewall or route change'],
            ['ORA-28040', 'No matching authentication protocol', 'Client driver older than the server allows'],
          ],
        },
      },
      {
        key: 'diagnostics',
        title: 'Diagnostic Sequence',
        paragraphs: [
          'Work outward from the database host. Restarting the listener before establishing the failure ' +
            'point destroys the evidence and frequently does not fix the problem.',
        ],
        steps: [
          'On the database host, confirm the listener is running and check its status output.',
          'Confirm the target service appears in the listener services list; an absent service means the ' +
            'instance has not registered.',
          'From the client, test TCP reachability to the listener port before testing Oracle connectivity.',
          'Resolve the connect identifier on the client and confirm it points at the expected host, port ' +
            'and service name.',
          'Attempt a connection using an explicit connect descriptor to bypass name resolution.',
          'Review the listener log for the failing period, matching on the client address.',
        ],
      },
      {
        key: 'configuration',
        title: 'Standard Configuration',
        paragraphs: [
          `Listeners run on port ${f('listenerPort')}. INBOUND_CONNECT_TIMEOUT is set to ` +
            `${f('connectTimeout')}, and clients are configured with ${f('retryCount')} before reporting a ` +
            'failure.',
        ],
      },
      {
        key: 'registration',
        title: 'Instance Registration',
        paragraphs: [
          `Instances register with the listener every ${f('registrationInterval')}. After a listener ` +
            'restart, a service may be briefly absent until the next registration; ORA-12514 during that ' +
            'window is expected and resolves without intervention.',
          'Where registration does not recover, confirm LOCAL_LISTENER is set correctly on the instance ' +
            'before restarting anything.',
        ],
      },
      {
        key: 'logs',
        title: 'Logs',
        paragraphs: [
          `Listener logs are retained for ${f('logRetention')}. Logs are reviewed before a restart, ` +
            'because a restart rotates the file and discards the evidence of the failure.',
        ],
      },
      {
        key: 'escalation',
        title: 'Escalation',
        paragraphs: [
          `Where the diagnostic sequence does not identify the cause within ${f('escalationTime')}, the ` +
            'issue is escalated to the Lead Database Administrator with the listener log extract and the ' +
            'exact client error attached.',
        ],
      },
      responsibilitiesSection([
        ['Database Administrator', 'Runs the diagnostic sequence and preserves listener logs'],
        ['Network Team', 'Confirms routing and firewall rules between client and database host'],
        ['Application Team', 'Provides the exact client error and connect descriptor in use'],
      ]),
      relatedDocumentsSection([
        'Oracle Database Performance Guidelines',
        'Production Incident Management Procedure',
      ]),
    ];
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'IDENTIFIER',
        question: 'What causes an ORA-12514 error?',
        sectionKey: 'common-errors',
        factIds: [],
        referenceAnswer:
          'ORA-12514 means the listener does not know of the requested service, usually because the instance has not registered with the listener.',
      },
      {
        type: 'DIRECT',
        question: 'What port do Oracle listeners run on?',
        sectionKey: 'configuration',
        factIds: ['listenerPort'],
        referenceAnswer: `Listeners run on port ${f('listenerPort')}.`,
      },
      {
        type: 'DIRECT',
        question: 'How long are Oracle listener logs retained?',
        sectionKey: 'logs',
        factIds: ['logRetention'],
        referenceAnswer: `Listener logs are retained for ${f('logRetention')}.`,
      },
      {
        type: 'TERMINOLOGY',
        question: 'How often do Oracle instances register with the listener?',
        sectionKey: 'registration',
        factIds: ['registrationInterval'],
        referenceAnswer: `Instances register with the listener every ${f('registrationInterval')}.`,
      },
    ];
  },
};

export const oraclePatchProcedure: Blueprint = {
  key: 'oracle-patch-procedure',
  codePrefix: 'ORA-GUIDE',
  title: 'Oracle Database Patch Procedure',
  department: 'Database Administration',
  documentType: 'PROCEDURE',
  category: 'Oracle Database',
  ownerRole: 'Lead Database Administrator',
  tags: ['oracle', 'patching', 'release update', 'change'],
  description:
    'Quarterly release update application, pre-patch validation, rollback criteria and post-patch ' +
    'verification for Oracle databases.',
  purpose:
    'This procedure defines how Oracle release updates are applied to managed databases, and the conditions ' +
    'under which a patch is rolled back.',
  scope: 'This procedure applies to all managed Oracle database homes, including standby environments.',

  facts: [
    fact('patchCadence', 'Patch application cadence', 'schedule', choice(['quarterly', 'every quarter', 'twice a year'])),
    fact('nonProdSoak', 'Non-production soak period', 'schedule', businessDays(5, 20)),
    fact('backupBefore', 'Pre-patch backup requirement', 'preparation', hours(1, 12)),
    fact('rollbackWindow', 'Rollback decision window', 'rollback', hours(1, 6)),
    fact('changeNotice', 'Change approval lead time', 'preparation', businessDays(3, 10)),
    fact('verificationPeriod', 'Post-patch verification period', 'verification', hours(12, 72)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'schedule',
        title: 'Patch Schedule',
        paragraphs: [
          `Oracle release updates are applied ${f('patchCadence')}. A release update is applied to ` +
            `non-production first and soaks for ${f('nonProdSoak')} before any production application.`,
          'Out-of-cycle patching occurs only for a security vulnerability with an active exploit, and ' +
            'follows the emergency change process.',
        ],
      },
      {
        key: 'preparation',
        title: 'Preparation',
        paragraphs: [
          `A change request is submitted at least ${f('changeNotice')} before the patch window. A full ` +
            `backup completed within ${f('backupBefore')} of the patch start is a precondition; without ` +
            'it, the window is cancelled.',
        ],
        steps: [
          'Confirm the release update has soaked in non-production for the required period.',
          'Verify a successful full backup within the required window and record the backup identifier.',
          'Confirm the standby is synchronised and note the current apply lag.',
          'Stage the patch on the database home and run the prerequisite checks.',
          'Take a guaranteed restore point before the patch is applied.',
        ],
      },
      {
        key: 'application',
        title: 'Applying the Patch',
        paragraphs: [
          'Standby databases are patched before the primary, so a failure is discovered where it does not ' +
            'affect production service.',
          'Datapatch is run against the database after the binary patch completes; a release update is not ' +
            'considered applied until the SQL changes have been registered.',
        ],
      },
      {
        key: 'rollback',
        title: 'Rollback',
        paragraphs: [
          `The decision to roll back is made within ${f('rollbackWindow')} of the patch completing. ` +
            'Beyond that window, rollback is by restore rather than by patch removal, because application ' +
            'writes have accumulated.',
          'Rollback criteria are agreed before the window opens: any failure of the documented smoke tests, ' +
            'or an unexplained change in the execution plan of a critical statement.',
        ],
      },
      {
        key: 'verification',
        title: 'Post-Patch Verification',
        paragraphs: [
          `The database is monitored for ${f('verificationPeriod')} after patching, comparing wait event ` +
            'profile and top SQL against the pre-patch baseline.',
          'The guaranteed restore point is dropped only after the verification period completes without ' +
            'incident.',
        ],
      },
      responsibilitiesSection([
        ['Database Administrator', 'Applies the patch and executes the documented verification steps'],
        ['Lead Database Administrator', 'Approves the rollback decision and owns this procedure'],
        ['Application Team', 'Executes smoke tests and confirms application health after patching'],
        ['Change Manager', 'Approves the change and confirms the window with stakeholders'],
      ]),
      exceptionsSection('Lead Database Administrator', 'a single patch cycle'),
      relatedDocumentsSection(['Oracle Backup and Recovery Guidelines', 'Change Management Standard']),
    ];
  },

  workflow() {
    return {
      title: 'Oracle patch application workflow',
      nodes: [
        'Release Update Available',
        'Non-Production Application',
        'Soak Period',
        'Change Approval',
        'Pre-Patch Backup',
        'Standby Patched',
        'Primary Patched',
        'Datapatch Executed',
        'Post-Patch Verification',
      ],
      expectedText:
        'Release Update Available -> Non-Production Application -> Soak Period -> Change Approval -> ' +
        'Pre-Patch Backup -> Standby Patched -> Primary Patched -> Datapatch Executed -> ' +
        'Post-Patch Verification',
    };
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'How often are Oracle release updates applied?',
        sectionKey: 'schedule',
        factIds: ['patchCadence'],
        referenceAnswer: `Oracle release updates are applied ${f('patchCadence')}.`,
      },
      {
        type: 'DIRECT',
        question: 'How long must a patch soak in non-production before production?',
        sectionKey: 'schedule',
        factIds: ['nonProdSoak'],
        referenceAnswer: `A release update soaks in non-production for ${f('nonProdSoak')} before production application.`,
      },
      {
        type: 'PARAPHRASE',
        question: 'Which is patched first, the standby or the primary database?',
        sectionKey: 'application',
        factIds: [],
        referenceAnswer:
          'Standby databases are patched before the primary, so a failure is discovered where it does not affect production service.',
      },
    ];
  },
};

/** Order fixes ORA-GUIDE-001..005; tablespace management is ORA-GUIDE-003. */
export const oracleBlueprints: Blueprint[] = [
  oraclePerformanceGuidelines,
  oracleBackupGuidelines,
  oracleTablespaceGuidelines,
  oracleListenerTroubleshooting,
  oraclePatchProcedure,
];
