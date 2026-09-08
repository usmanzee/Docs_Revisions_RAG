/** Procurement, Operations, Compliance and Enterprise Applications blueprints. */

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
  money,
  months,
  percent,
  relatedDocumentsSection,
  responsibilitiesSection,
  years,
  type Blueprint,
} from './shared.js';

export const vendorProcurementPolicy: Blueprint = {
  key: 'vendor-procurement-policy',
  codePrefix: 'PROC-POL',
  title: 'Vendor Procurement Policy',
  department: 'Procurement',
  documentType: 'POLICY',
  category: 'Sourcing',
  ownerRole: 'Procurement Manager',
  tags: ['procurement', 'vendor', 'sourcing', 'tender'],
  description:
    'Defines competitive tendering thresholds, vendor due diligence, contract approval and the treatment of ' +
    'single-source awards.',
  purpose:
    'This policy establishes how suppliers are selected and engaged, so that spend is competitive, ' +
    'defensible and free of undisclosed conflicts of interest.',
  scope:
    'This policy applies to every commitment to an external supplier, including renewals, extensions and ' +
    'purchases made on a corporate card.',

  facts: [
    fact('quoteThreshold', 'Threshold requiring written quotations', 'tendering', money(5000, 25000, 1000)),
    fact('quoteCount', 'Number of quotations required', 'tendering', count(2, 4, 'written quotations')),
    fact('tenderThreshold', 'Formal tender threshold', 'tendering', money(50000, 250000, 10000)),
    fact('tenderPeriod', 'Minimum tender response period', 'tendering', calendarDaysAlias(14, 45)),
    fact('dueDiligenceDays', 'Vendor due diligence period', 'due-diligence', businessDays(5, 20)),
    fact('contractReview', 'Contract review cadence', 'contract-management', months(12, 36)),
    fact('singleSourceApprover', 'Single-source approval authority', 'single-source', choice(['Procurement Manager', 'Chief Financial Officer', 'Head of Operations'])),
    fact('paymentTerms', 'Standard payment terms', 'contract-management', days(30, 60)),
    fact('insuranceMinimum', 'Minimum supplier liability cover', 'due-diligence', money(1000000, 5000000, 500000)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'tendering',
        title: 'Competitive Tendering',
        paragraphs: [
          `Purchases above ${f('quoteThreshold')} require ${f('quoteCount')} from suppliers capable of ` +
            `meeting the requirement. Purchases above ${f('tenderThreshold')} require a formal tender ` +
            `with a response period of at least ${f('tenderPeriod')}.`,
          'Requirements must be specified in terms of outcome rather than a named product, unless ' +
            'compatibility with an existing system makes a named product unavoidable.',
        ],
        table: {
          caption: 'Sourcing requirements by value',
          header: ['Commitment value', 'Sourcing requirement', 'Approval'],
          rows: [
            [`Up to ${f('quoteThreshold')}`, 'Single quotation', 'Budget holder'],
            [
              `Above ${f('quoteThreshold')} up to ${f('tenderThreshold')}`,
              f('quoteCount'),
              'Procurement Manager',
            ],
            [`Above ${f('tenderThreshold')}`, 'Formal competitive tender', 'Chief Financial Officer'],
          ],
        },
      },
      {
        key: 'due-diligence',
        title: 'Vendor Due Diligence',
        paragraphs: [
          `Due diligence is completed within ${f('dueDiligenceDays')} of shortlisting and covers financial ` +
            'standing, information security posture, and sanctions screening.',
          `Suppliers must hold liability cover of at least ${f('insuranceMinimum')}, evidenced before the ` +
            'contract is signed.',
        ],
      },
      {
        key: 'single-source',
        title: 'Single-Source Awards',
        paragraphs: [
          `A single-source award requires the written approval of the ${f('singleSourceApprover')} and a ` +
            'documented justification explaining why competition is not possible.',
          'Urgency created by late planning is not an acceptable justification for a single-source award.',
        ],
      },
      {
        key: 'contract-management',
        title: 'Contract Management',
        paragraphs: [
          `Standard payment terms are ${f('paymentTerms')} from receipt of a valid invoice. Shorter terms ` +
            'require Finance approval and are agreed in exchange for a commercial benefit.',
          `Every contract has a named owner and is reviewed every ${f('contractReview')}, or before any ` +
            'automatic renewal date, whichever falls first.',
        ],
      },
      definitionsSection([
        ['Commitment', 'any agreement creating a financial obligation, including a verbal order'],
        ['Single source', 'an award made without competition to one identified supplier'],
        ['Due diligence', 'the pre-contract assessment of a supplier’s financial and security standing'],
      ]),
      responsibilitiesSection([
        ['Budget Holder', 'Defines the requirement and confirms the budget before sourcing begins'],
        ['Procurement Manager', 'Runs the sourcing process and approves single-source justifications'],
        ['Legal', 'Reviews contract terms and confirms liability and indemnity positions'],
        ['Information Security', 'Assesses supplier security posture where data is shared'],
      ]),
      exceptionsSection('Procurement Manager', 'the specific purchase to which they relate'),
      complianceSection('annually', 'Procurement Manager'),
      relatedDocumentsSection(['Business Expense Policy', 'Information Classification Policy']),
    ];
  },

  workflow() {
    return {
      title: 'Purchase request approval workflow',
      nodes: [
        'Purchase Request',
        'Budget Holder Review',
        'Procurement Sourcing',
        'Vendor Due Diligence',
        'Finance Approval',
        'Purchase Order Issued',
        'Vendor Delivery',
      ],
      expectedText:
        'Purchase Request -> Budget Holder Review -> Procurement Sourcing -> Vendor Due Diligence -> ' +
        'Finance Approval -> Purchase Order Issued -> Vendor Delivery',
    };
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'What purchase value requires a formal competitive tender?',
        sectionKey: 'tendering',
        factIds: ['tenderThreshold'],
        referenceAnswer: `Purchases above ${f('tenderThreshold')} require a formal tender with a response period of at least ${f('tenderPeriod')}.`,
      },
      {
        type: 'DIRECT',
        question: 'How many written quotations are required for mid-value purchases?',
        sectionKey: 'tendering',
        factIds: ['quoteCount', 'quoteThreshold'],
        referenceAnswer: `Purchases above ${f('quoteThreshold')} require ${f('quoteCount')}.`,
      },
      {
        type: 'DIRECT',
        question: 'What are the standard supplier payment terms?',
        sectionKey: 'contract-management',
        factIds: ['paymentTerms'],
        referenceAnswer: `Standard payment terms are ${f('paymentTerms')} from receipt of a valid invoice.`,
      },
      {
        type: 'PARAPHRASE',
        question: 'Who signs off when we buy from one supplier without competing the work?',
        sectionKey: 'single-source',
        factIds: ['singleSourceApprover'],
        referenceAnswer: `A single-source award requires the written approval of the ${f('singleSourceApprover')} with a documented justification.`,
      },
    ];
  },
};

export const changeManagementStandard: Blueprint = {
  key: 'change-management-standard',
  codePrefix: 'OPS-STD',
  title: 'Change Management Standard',
  department: 'Operations',
  documentType: 'STANDARD',
  category: 'Service Management',
  ownerRole: 'Head of Operations',
  tags: ['change', 'cab', 'release', 'freeze'],
  description:
    'Change categories, approval routes, freeze periods and post-implementation review for production ' +
    'changes.',
  purpose:
    'This standard defines how changes to production services are classified, approved, implemented and ' +
    'reviewed.',
  scope: 'This standard applies to every change affecting a production service or its supporting infrastructure.',

  facts: [
    fact('standardLeadTime', 'Normal change lead time', 'change-categories', businessDays(3, 10)),
    fact('emergencyApprover', 'Emergency change approver', 'emergency-change', choice(['Head of Operations', 'Duty Incident Manager', 'Chief Information Officer'])),
    fact('cabDay', 'Change advisory board day', 'approval', choice(['Monday', 'Tuesday', 'Wednesday', 'Thursday'])),
    fact('freezeStart', 'Annual freeze start', 'freeze-periods', choice(['15 December', '20 December', '1 December'])),
    fact('freezeEnd', 'Annual freeze end', 'freeze-periods', choice(['5 January', '10 January', '15 January'])),
    fact('pirWindow', 'Post-implementation review window', 'review', businessDays(2, 10)),
    fact('successTarget', 'Change success rate target', 'review', percent(90, 99, 1)),
    fact('emergencyRetro', 'Emergency change retrospective approval', 'emergency-change', businessDays(1, 5)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'change-categories',
        title: 'Change Categories',
        paragraphs: [
          `Changes are classified as standard, normal or emergency. A normal change requires ` +
            `${f('standardLeadTime')} of lead time before the implementation window.`,
          'Standard changes are pre-approved, low-risk and executed from a documented runbook. A change ' +
            'becomes standard only after it has been executed successfully as a normal change several ' +
            'times without incident.',
        ],
        table: {
          caption: 'Change categories',
          header: ['Category', 'Risk', 'Approval', 'Lead time'],
          rows: [
            ['Standard', 'Low, pre-approved runbook', 'Automatic', 'None'],
            ['Normal', 'Assessed per change', `Change advisory board (${f('cabDay')})`, f('standardLeadTime')],
            ['Emergency', 'Resolving or preventing an incident', f('emergencyApprover'), 'Immediate'],
          ],
        },
      },
      {
        key: 'approval',
        title: 'Approval',
        paragraphs: [
          `The change advisory board meets weekly on ${f('cabDay')}. Changes are assessed on business ` +
            'impact, backout viability and the quality of the test evidence.',
          'A change without a tested backout plan is not approved, regardless of how low its assessed risk ' +
            'is.',
        ],
      },
      {
        key: 'emergency-change',
        title: 'Emergency Change',
        paragraphs: [
          `An emergency change may be authorised verbally by the ${f('emergencyApprover')} when it resolves ` +
            'or prevents a production incident. The change record is raised retrospectively within ' +
            `${f('emergencyRetro')} with the full detail of what was done.`,
        ],
      },
      {
        key: 'freeze-periods',
        title: 'Freeze Periods',
        paragraphs: [
          `A change freeze applies from ${f('freezeStart')} to ${f('freezeEnd')}, and around any ` +
            'announced peak trading period. Only emergency changes are implemented during a freeze.',
        ],
      },
      {
        key: 'review',
        title: 'Review and Metrics',
        paragraphs: [
          `A post-implementation review is completed within ${f('pirWindow')} for every failed or partially ` +
            `successful change. The change success rate target is ${f('successTarget')}.`,
        ],
      },
      responsibilitiesSection([
        ['Change Requester', 'Provides test evidence, a backout plan and an accurate impact assessment'],
        ['Change Advisory Board', 'Assesses risk and approves or defers normal changes'],
        ['Head of Operations', 'Owns this standard and authorises emergency changes'],
        ['Service Owner', 'Confirms service health after implementation'],
      ]),
      exceptionsSection('Head of Operations', 'the specific change to which they relate'),
      relatedDocumentsSection(['Production Incident Management Procedure', 'Oracle Database Patch Procedure']),
    ];
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'How much lead time does a normal change require?',
        sectionKey: 'change-categories',
        factIds: ['standardLeadTime'],
        referenceAnswer: `A normal change requires ${f('standardLeadTime')} of lead time before implementation.`,
      },
      {
        type: 'DIRECT',
        question: 'When does the annual change freeze apply?',
        sectionKey: 'freeze-periods',
        factIds: ['freezeStart', 'freezeEnd'],
        referenceAnswer: `A change freeze applies from ${f('freezeStart')} to ${f('freezeEnd')}.`,
      },
      {
        type: 'PARAPHRASE',
        question: 'Can a change be approved without a rollback plan?',
        sectionKey: 'approval',
        factIds: [],
        referenceAnswer:
          'No. A change without a tested backout plan is not approved, regardless of its assessed risk.',
      },
    ];
  },
};

export const dataRetentionStandard: Blueprint = {
  key: 'data-retention-standard',
  codePrefix: 'CMP-STD',
  title: 'Data Retention and Disposal Standard',
  department: 'Compliance',
  documentType: 'STANDARD',
  category: 'Records Management',
  ownerRole: 'Head of Compliance',
  tags: ['retention', 'disposal', 'records', 'legal hold'],
  description:
    'Retention periods by record class, legal hold handling and the evidence required for defensible ' +
    'disposal.',
  purpose:
    'This standard defines how long each class of business record is retained and how records are disposed ' +
    'of once their retention period expires.',
  scope: 'This standard applies to all business records regardless of the system or medium holding them.',

  facts: [
    fact('financialRetention', 'Financial record retention', 'retention-schedule', years(6, 10)),
    fact('hrRetention', 'Employee record retention after leaving', 'retention-schedule', years(3, 7)),
    fact('contractRetention', 'Contract retention after expiry', 'retention-schedule', years(6, 12)),
    fact('emailRetention', 'Default mailbox retention', 'retention-schedule', months(12, 84)),
    fact('logRetention', 'Security log retention', 'retention-schedule', months(6, 24)),
    fact('holdNotice', 'Legal hold notification time', 'legal-hold', hours(4, 48)),
    fact('disposalReview', 'Disposal review cadence', 'disposal', months(3, 12)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'retention-schedule',
        title: 'Retention Schedule',
        paragraphs: [
          'Retention periods run from the end of the calendar year in which the record was last used for a ' +
            'business purpose, unless a regulation specifies a different starting point.',
        ],
        table: {
          caption: 'Retention by record class',
          header: ['Record class', 'Retention period', 'Owner'],
          rows: [
            ['Financial records and tax documentation', f('financialRetention'), 'Finance'],
            ['Employee records after leaving', f('hrRetention'), 'Human Resources'],
            ['Contracts after expiry', f('contractRetention'), 'Legal'],
            ['Email, default mailbox policy', f('emailRetention'), 'Information Technology'],
            ['Security and access logs', f('logRetention'), 'Information Security'],
          ],
        },
      },
      {
        key: 'legal-hold',
        title: 'Legal Hold',
        paragraphs: [
          `When litigation or a regulatory investigation is reasonably anticipated, Legal issues a hold ` +
            `notice within ${f('holdNotice')} to every custodian of relevant records.`,
          'A record under legal hold is never disposed of, regardless of its retention period. Automated ' +
            'disposal is suspended for the affected scope until the hold is released in writing.',
        ],
      },
      {
        key: 'disposal',
        title: 'Defensible Disposal',
        paragraphs: [
          `Records eligible for disposal are reviewed every ${f('disposalReview')}. Disposal is recorded ` +
            'with the record class, the volume disposed of, the date, and the authorising role.',
          'Disposal without a record of what was destroyed is not defensible and is treated as a control ' +
            'failure.',
        ],
      },
      responsibilitiesSection([
        ['Record Owner', 'Classifies records and confirms eligibility before disposal'],
        ['Legal', 'Issues and releases legal holds and advises on statutory periods'],
        ['Head of Compliance', 'Owns this standard and reports on disposal activity'],
        ['Information Technology', 'Implements retention rules in the systems that hold records'],
      ]),
      relatedDocumentsSection(['Information Classification Policy', 'Backup and Recovery Procedure']),
    ];
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'How long are financial records retained?',
        sectionKey: 'retention-schedule',
        factIds: ['financialRetention'],
        referenceAnswer: `Financial records and tax documentation are retained for ${f('financialRetention')}.`,
      },
      {
        type: 'DIRECT',
        question: 'What happens to retention when a legal hold is in place?',
        sectionKey: 'legal-hold',
        factIds: [],
        referenceAnswer:
          'A record under legal hold is never disposed of regardless of its retention period, and automated disposal is suspended for the affected scope.',
      },
      {
        type: 'DIRECT',
        question: 'How long are security logs retained?',
        sectionKey: 'retention-schedule',
        factIds: ['logRetention'],
        referenceAnswer: `Security and access logs are retained for ${f('logRetention')}.`,
      },
    ];
  },
};

export const erpAccessStandard: Blueprint = {
  key: 'erp-access-standard',
  codePrefix: 'ERP-STD',
  title: 'ERP Access and Segregation of Duties Standard',
  department: 'Enterprise Applications',
  documentType: 'STANDARD',
  category: 'ERP',
  ownerRole: 'Head of Enterprise Applications',
  tags: ['erp', 'access', 'segregation of duties', 'roles'],
  description:
    'Role-based access, segregation of duties rules, periodic recertification and emergency access handling ' +
    'for the ERP platform.',
  purpose:
    'This standard defines how ERP access is granted, reviewed and revoked, and which duty combinations may ' +
    'never be held by one person.',
  scope: 'This standard applies to all ERP modules and to any integration account with ERP write access.',

  facts: [
    fact('recertifyCycle', 'Access recertification cycle', 'recertification', months(3, 12)),
    fact('leaverRevocation', 'Leaver access revocation', 'joiners-leavers', hours(2, 24)),
    fact('firefighterWindow', 'Emergency access validity', 'emergency-access', hours(2, 12)),
    fact('firefighterReview', 'Emergency access log review', 'emergency-access', businessDays(1, 5)),
    fact('approvalLevels', 'Approvals required for privileged ERP roles', 'granting-access', count(2, 3, 'approvals')),
    fact('sodExceptionValidity', 'SoD exception validity', 'segregation-of-duties', months(3, 12)),
    fact('provisioningSla', 'Access provisioning time', 'granting-access', businessDays(1, 5)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'granting-access',
        title: 'Granting Access',
        paragraphs: [
          `ERP access is granted by role, never by direct permission assignment. A request for a privileged ` +
            `role requires ${f('approvalLevels')}: the line manager and the module owner, and for roles ` +
            'that can post financial transactions, Finance as well.',
          `Approved access is provisioned within ${f('provisioningSla')}. Access granted outside the ` +
            'request process is revoked at the next recertification and reported as a control breach.',
        ],
      },
      {
        key: 'segregation-of-duties',
        title: 'Segregation of Duties',
        paragraphs: [
          'The following duty combinations may never be held by the same person. Where the organisation is ' +
            'too small to separate them, a compensating detective control is documented and operated.',
          `An approved segregation-of-duties exception is valid for ${f('sodExceptionValidity')} and is ` +
            'reviewed at every recertification.',
        ],
        table: {
          caption: 'Prohibited duty combinations',
          header: ['Duty A', 'Duty B', 'Risk'],
          rows: [
            ['Create supplier', 'Approve payment', 'Fictitious supplier payment'],
            ['Raise purchase order', 'Receive goods', 'Unverified receipt'],
            ['Amend employee bank details', 'Approve payroll run', 'Diverted salary payment'],
            ['Post journal', 'Approve journal', 'Unreviewed financial adjustment'],
          ],
        },
      },
      {
        key: 'recertification',
        title: 'Recertification',
        paragraphs: [
          `All ERP access is recertified every ${f('recertifyCycle')}. Managers confirm each report’s roles ` +
            'are still required; access not positively confirmed is removed.',
          'Recertification is not a formality: a manager who approves without review is recorded as the ' +
            'accountable party for any resulting control failure.',
        ],
      },
      {
        key: 'joiners-leavers',
        title: 'Joiners, Movers and Leavers',
        paragraphs: [
          `ERP access is revoked within ${f('leaverRevocation')} of a leaver’s final working day. For ` +
            'movers, previous access is removed at the same time new access is granted, rather than ' +
            'accumulating over a career.',
        ],
      },
      {
        key: 'emergency-access',
        title: 'Emergency Access',
        paragraphs: [
          `Emergency access is time-boxed to ${f('firefighterWindow')} and expires automatically. Every ` +
            `emergency session is logged and reviewed within ${f('firefighterReview')} by the module owner.`,
        ],
      },
      definitionsSection([
        ['Segregation of duties', 'the separation of conflicting duties between different individuals'],
        ['Recertification', 'the periodic confirmation that granted access is still required'],
        ['Emergency access', 'temporary elevated access granted to resolve an incident'],
      ]),
      responsibilitiesSection([
        ['Line Manager', 'Requests appropriate access and performs recertification honestly'],
        ['Module Owner', 'Approves privileged roles and reviews emergency access logs'],
        ['Head of Enterprise Applications', 'Owns this standard and the segregation-of-duties ruleset'],
        ['Internal Audit', 'Tests the operation of these controls independently'],
      ]),
      exceptionsSection('Head of Enterprise Applications', 'one recertification cycle'),
      relatedDocumentsSection(['Password Security Policy', 'Vendor Procurement Policy']),
    ];
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'How often is ERP access recertified?',
        sectionKey: 'recertification',
        factIds: ['recertifyCycle'],
        referenceAnswer: `All ERP access is recertified every ${f('recertifyCycle')}.`,
      },
      {
        type: 'DIRECT',
        question: 'How quickly is ERP access revoked when someone leaves?',
        sectionKey: 'joiners-leavers',
        factIds: ['leaverRevocation'],
        referenceAnswer: `ERP access is revoked within ${f('leaverRevocation')} of the leaver's final working day.`,
      },
      {
        type: 'CROSS_SECTION',
        question: 'Can the same person create a supplier and approve a payment to it?',
        sectionKey: 'segregation-of-duties',
        factIds: [],
        referenceAnswer:
          'No. Creating a supplier and approving a payment is a prohibited duty combination because it enables fictitious supplier payments.',
      },
      {
        type: 'DIRECT',
        question: 'How long does emergency ERP access remain valid?',
        sectionKey: 'emergency-access',
        factIds: ['firefighterWindow'],
        referenceAnswer: `Emergency access is time-boxed to ${f('firefighterWindow')} and expires automatically.`,
      },
    ];
  },
};

export const serviceDeskFaq: Blueprint = {
  key: 'service-desk-faq',
  codePrefix: 'OPS-FAQ',
  title: 'Service Desk Frequently Asked Questions',
  department: 'Operations',
  documentType: 'FAQ',
  category: 'Service Management',
  ownerRole: 'Service Desk Manager',
  tags: ['service desk', 'faq', 'support', 'sla'],
  description: 'Answers to the questions the service desk receives most often, with the applicable targets.',
  purpose: 'This document answers common support questions without requiring a ticket.',
  scope: 'This document applies to all employees requesting support from the service desk.',

  facts: [
    fact('deskHours', 'Service desk hours', 'contacting-the-desk', choice(['08:00 to 18:00', '07:30 to 19:00', '24 hours'])),
    fact('firstResponse', 'First response target', 'response-times', minutes(15, 120, 15)),
    fact('passwordReset', 'Password reset turnaround', 'common-requests', minutes(5, 30, 5)),
    fact('hardwareLead', 'Standard hardware request lead time', 'common-requests', businessDays(3, 15)),
    fact('softwareApproval', 'Software request approval time', 'common-requests', businessDays(1, 10)),
    fact('escalationPath', 'Escalation contact', 'escalation', choice(['Service Desk Manager', 'Duty Incident Manager'])),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'contacting-the-desk',
        title: 'How do I contact the service desk?',
        paragraphs: [
          `The service desk operates ${f('deskHours')} on business days. Requests are raised through the ` +
            'self-service portal; the telephone line is reserved for incidents affecting production.',
        ],
      },
      {
        key: 'response-times',
        title: 'How quickly will I get a response?',
        paragraphs: [
          `The first response target is ${f('firstResponse')} during service desk hours. Response time is ` +
            'measured from ticket submission, not from when it is read.',
        ],
      },
      {
        key: 'common-requests',
        title: 'How long do common requests take?',
        paragraphs: ['The most frequent requests have the following published targets.'],
        table: {
          caption: 'Common request targets',
          header: ['Request', 'Target', 'Approval required'],
          rows: [
            ['Password reset', f('passwordReset'), 'Identity verification only'],
            ['Standard hardware', f('hardwareLead'), 'Line manager'],
            ['Software installation', f('softwareApproval'), 'Line manager and security review'],
            ['Access to a shared drive', '2 business days', 'Data owner'],
          ],
        },
      },
      {
        key: 'escalation',
        title: 'What if my ticket is not progressing?',
        paragraphs: [
          `Where a ticket has not progressed against its target, ask the ${f('escalationPath')} to review ` +
            'it, quoting the ticket reference. Raising a duplicate ticket delays resolution rather than ' +
            'accelerating it.',
        ],
      },
      relatedDocumentsSection(['Production Incident Management Procedure', 'Password Security Policy']),
    ];
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'What are the service desk operating hours?',
        sectionKey: 'contacting-the-desk',
        factIds: ['deskHours'],
        referenceAnswer: `The service desk operates ${f('deskHours')} on business days.`,
      },
      {
        type: 'DIRECT',
        question: 'How long does a password reset take?',
        sectionKey: 'common-requests',
        factIds: ['passwordReset'],
        referenceAnswer: `A password reset is completed within ${f('passwordReset')} after identity verification.`,
      },
    ];
  },
};

/** Local alias so the tender period reads naturally in calendar days. */
function calendarDaysAlias(min: number, max: number) {
  return (rng: Parameters<ReturnType<typeof days>>[0]) => {
    const value = days(min, max)(rng);
    return { ...value, value: value.value.replace(' days', ' calendar days'), unit: 'calendar days' };
  };
}

export const operationsBlueprints: Blueprint[] = [
  vendorProcurementPolicy,
  changeManagementStandard,
  dataRetentionStandard,
  erpAccessStandard,
  serviceDeskFaq,
];
