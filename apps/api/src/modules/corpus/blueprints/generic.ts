/**
 * Generated blueprints for corpus depth.
 *
 * The hand-written blueprints give the corpus its anchor documents - the ones
 * the demo scenarios and gold questions reference by code. But a realistic
 * enterprise repository has thousands of documents, and a scale corpus needs
 * that volume without becoming lorem ipsum.
 *
 * These blueprints are assembled from a catalogue of real enterprise topics.
 * Each one still asserts typed facts in named sections and still produces
 * answerable questions - the content is thinner than a hand-written blueprint,
 * but it is coherent, department-appropriate prose rather than filler.
 */

import type { Department, DocumentType } from '@docs-rag/shared';
import {
  businessDays,
  complianceSection,
  count,
  days,
  definitionsSection,
  exceptionsSection,
  fact,
  hours,
  money,
  months,
  percent,
  relatedDocumentsSection,
  responsibilitiesSection,
  years,
  type Blueprint,
} from './shared.js';

interface TopicSpec {
  title: string;
  department: Department;
  documentType: DocumentType;
  category: string;
  codePrefix: string;
  owner: string;
  /** Subject noun used throughout the generated prose. */
  subject: string;
  tags: string[];
}

/**
 * Topic catalogue. Ordered by department so generated codes cluster the way a
 * real document register does.
 */
const TOPICS: TopicSpec[] = [
  // Human Resources
  { title: 'Sickness Absence Procedure', department: 'Human Resources', documentType: 'PROCEDURE', category: 'Leave and Absence', codePrefix: 'HR-PROC', owner: 'HR Operations Manager', subject: 'sickness absence reporting', tags: ['absence', 'sickness'] },
  { title: 'Recruitment and Selection Policy', department: 'Human Resources', documentType: 'POLICY', category: 'Recruitment', codePrefix: 'HR-POL', owner: 'Head of Talent', subject: 'recruitment and candidate selection', tags: ['recruitment', 'hiring'] },
  { title: 'Performance Review Procedure', department: 'Human Resources', documentType: 'PROCEDURE', category: 'Performance', codePrefix: 'HR-PROC', owner: 'Head of Human Resources', subject: 'the performance review cycle', tags: ['performance', 'review'] },
  { title: 'Learning and Development Standard', department: 'Human Resources', documentType: 'STANDARD', category: 'Development', codePrefix: 'HR-STD', owner: 'Learning Manager', subject: 'training and professional development', tags: ['training', 'development'] },
  { title: 'Grievance and Disciplinary Procedure', department: 'Human Resources', documentType: 'PROCEDURE', category: 'Employee Relations', codePrefix: 'HR-PROC', owner: 'Head of Human Resources', subject: 'grievance and disciplinary handling', tags: ['grievance', 'disciplinary'] },
  { title: 'Onboarding Manual', department: 'Human Resources', documentType: 'MANUAL', category: 'Onboarding', codePrefix: 'HR-MAN', owner: 'HR Operations Manager', subject: 'new joiner onboarding', tags: ['onboarding', 'induction'] },
  { title: 'Flexible Working Guideline', department: 'Human Resources', documentType: 'GUIDELINE', category: 'Working Arrangements', codePrefix: 'HR-GUIDE', owner: 'Head of Human Resources', subject: 'flexible working requests', tags: ['flexible', 'working hours'] },

  // Finance
  { title: 'Capital Expenditure Policy', department: 'Finance', documentType: 'POLICY', category: 'Capital', codePrefix: 'FIN-POL', owner: 'Chief Financial Officer', subject: 'capital expenditure approval', tags: ['capex', 'investment'] },
  { title: 'Month End Close Procedure', department: 'Finance', documentType: 'PROCEDURE', category: 'Reporting', codePrefix: 'FIN-PROC', owner: 'Financial Controller', subject: 'the month end close', tags: ['close', 'reporting'] },
  { title: 'Accounts Payable Procedure', department: 'Finance', documentType: 'PROCEDURE', category: 'Payables', codePrefix: 'FIN-PROC', owner: 'Accounts Payable Manager', subject: 'supplier invoice processing', tags: ['payables', 'invoices'] },
  { title: 'Corporate Card Guideline', department: 'Finance', documentType: 'GUIDELINE', category: 'Expenses', codePrefix: 'FIN-GUIDE', owner: 'Finance Director', subject: 'corporate card usage', tags: ['card', 'expenses'] },
  { title: 'Budgeting and Forecasting Standard', department: 'Finance', documentType: 'STANDARD', category: 'Planning', codePrefix: 'FIN-STD', owner: 'Head of Financial Planning', subject: 'budgeting and forecasting', tags: ['budget', 'forecast'] },
  { title: 'Revenue Recognition Policy', department: 'Finance', documentType: 'POLICY', category: 'Reporting', codePrefix: 'FIN-POL', owner: 'Financial Controller', subject: 'revenue recognition', tags: ['revenue', 'accounting'] },

  // Information Technology
  { title: 'Acceptable Use Policy', department: 'Information Technology', documentType: 'POLICY', category: 'End User Computing', codePrefix: 'IT-POL', owner: 'Chief Information Officer', subject: 'acceptable use of corporate systems', tags: ['acceptable use', 'devices'] },
  { title: 'Software Asset Management Standard', department: 'Information Technology', documentType: 'STANDARD', category: 'Asset Management', codePrefix: 'IT-STD', owner: 'IT Asset Manager', subject: 'software licence management', tags: ['licensing', 'assets'] },
  { title: 'Network Configuration Standard', department: 'Information Technology', documentType: 'STANDARD', category: 'Infrastructure', codePrefix: 'IT-STD', owner: 'Head of Infrastructure', subject: 'network configuration baselines', tags: ['network', 'configuration'] },
  { title: 'Server Hardening Guideline', department: 'Information Technology', documentType: 'GUIDELINE', category: 'Infrastructure', codePrefix: 'IT-GUIDE', owner: 'Head of Infrastructure', subject: 'server build hardening', tags: ['hardening', 'baseline'] },
  { title: 'Disaster Recovery Standard', department: 'Information Technology', documentType: 'STANDARD', category: 'Resilience', codePrefix: 'IT-STD', owner: 'Head of Infrastructure', subject: 'disaster recovery capability', tags: ['dr', 'resilience'] },
  { title: 'Monitoring and Alerting Manual', department: 'Information Technology', documentType: 'MANUAL', category: 'Service Management', codePrefix: 'IT-MAN', owner: 'Head of IT Operations', subject: 'production monitoring and alerting', tags: ['monitoring', 'alerting'] },
  { title: 'End User Device Procedure', department: 'Information Technology', documentType: 'PROCEDURE', category: 'End User Computing', codePrefix: 'IT-PROC', owner: 'Service Desk Manager', subject: 'device issue and return', tags: ['devices', 'laptops'] },

  // Information Security
  { title: 'Vulnerability Management Standard', department: 'Information Security', documentType: 'STANDARD', category: 'Threat Management', codePrefix: 'SEC-STD', owner: 'Head of Security Operations', subject: 'vulnerability remediation', tags: ['vulnerability', 'patching'] },
  { title: 'Security Incident Response Procedure', department: 'Information Security', documentType: 'PROCEDURE', category: 'Incident Response', codePrefix: 'SEC-PROC', owner: 'Head of Security Operations', subject: 'security incident response', tags: ['incident', 'response'] },
  { title: 'Third Party Security Assessment Standard', department: 'Information Security', documentType: 'STANDARD', category: 'Third Party Risk', codePrefix: 'SEC-STD', owner: 'Chief Information Security Officer', subject: 'third party security assessment', tags: ['third party', 'assessment'] },
  { title: 'Encryption Standard', department: 'Information Security', documentType: 'STANDARD', category: 'Cryptography', codePrefix: 'SEC-STD', owner: 'Chief Information Security Officer', subject: 'cryptographic controls', tags: ['encryption', 'keys'] },
  { title: 'Security Awareness Guideline', department: 'Information Security', documentType: 'GUIDELINE', category: 'Awareness', codePrefix: 'SEC-GUIDE', owner: 'Security Awareness Lead', subject: 'security awareness training', tags: ['awareness', 'phishing'] },

  // Procurement
  { title: 'Supplier Onboarding Procedure', department: 'Procurement', documentType: 'PROCEDURE', category: 'Sourcing', codePrefix: 'PROC-PROC', owner: 'Procurement Manager', subject: 'supplier onboarding', tags: ['supplier', 'onboarding'] },
  { title: 'Contract Renewal Guideline', department: 'Procurement', documentType: 'GUIDELINE', category: 'Contracts', codePrefix: 'PROC-GUIDE', owner: 'Contracts Manager', subject: 'contract renewal review', tags: ['contracts', 'renewal'] },
  { title: 'Purchase Order Manual', department: 'Procurement', documentType: 'MANUAL', category: 'Purchasing', codePrefix: 'PROC-MAN', owner: 'Procurement Manager', subject: 'purchase order raising and receipting', tags: ['purchase order', 'receipting'] },
  { title: 'Supplier Performance Standard', department: 'Procurement', documentType: 'STANDARD', category: 'Supplier Management', codePrefix: 'PROC-STD', owner: 'Head of Procurement', subject: 'supplier performance review', tags: ['supplier', 'performance'] },

  // Operations
  { title: 'Business Continuity Policy', department: 'Operations', documentType: 'POLICY', category: 'Resilience', codePrefix: 'OPS-POL', owner: 'Head of Operations', subject: 'business continuity planning', tags: ['continuity', 'resilience'] },
  { title: 'Facilities Access Procedure', department: 'Operations', documentType: 'PROCEDURE', category: 'Facilities', codePrefix: 'OPS-PROC', owner: 'Facilities Manager', subject: 'building access control', tags: ['facilities', 'access'] },
  { title: 'Health and Safety Standard', department: 'Operations', documentType: 'STANDARD', category: 'Safety', codePrefix: 'OPS-STD', owner: 'Health and Safety Officer', subject: 'workplace health and safety', tags: ['safety', 'health'] },
  { title: 'Capacity Planning Workflow', department: 'Operations', documentType: 'WORKFLOW', category: 'Planning', codePrefix: 'OPS-WF', owner: 'Head of Operations', subject: 'capacity planning', tags: ['capacity', 'planning'] },

  // Compliance
  { title: 'Anti-Bribery and Corruption Policy', department: 'Compliance', documentType: 'POLICY', category: 'Ethics', codePrefix: 'CMP-POL', owner: 'Head of Compliance', subject: 'anti-bribery controls', tags: ['bribery', 'ethics'] },
  { title: 'Conflicts of Interest Procedure', department: 'Compliance', documentType: 'PROCEDURE', category: 'Ethics', codePrefix: 'CMP-PROC', owner: 'Head of Compliance', subject: 'conflict of interest declaration', tags: ['conflict', 'declaration'] },
  { title: 'Regulatory Reporting Standard', department: 'Compliance', documentType: 'STANDARD', category: 'Reporting', codePrefix: 'CMP-STD', owner: 'Head of Compliance', subject: 'regulatory reporting', tags: ['regulatory', 'reporting'] },
  { title: 'Whistleblowing Guideline', department: 'Compliance', documentType: 'GUIDELINE', category: 'Ethics', codePrefix: 'CMP-GUIDE', owner: 'Head of Compliance', subject: 'protected disclosure handling', tags: ['whistleblowing', 'disclosure'] },
  { title: 'Internal Audit Manual', department: 'Compliance', documentType: 'MANUAL', category: 'Assurance', codePrefix: 'CMP-MAN', owner: 'Head of Internal Audit', subject: 'internal audit execution', tags: ['audit', 'assurance'] },

  // Database Administration
  { title: 'Database Change Control Procedure', department: 'Database Administration', documentType: 'PROCEDURE', category: 'Change', codePrefix: 'DBA-PROC', owner: 'Lead Database Administrator', subject: 'database schema change control', tags: ['schema', 'change'] },
  { title: 'Database Security Standard', department: 'Database Administration', documentType: 'STANDARD', category: 'Security', codePrefix: 'DBA-STD', owner: 'Lead Database Administrator', subject: 'database access and auditing', tags: ['database', 'security'] },
  { title: 'Database Capacity Guideline', department: 'Database Administration', documentType: 'GUIDELINE', category: 'Capacity', codePrefix: 'DBA-GUIDE', owner: 'Lead Database Administrator', subject: 'database capacity planning', tags: ['capacity', 'growth'] },
  { title: 'High Availability Standard', department: 'Database Administration', documentType: 'STANDARD', category: 'Resilience', codePrefix: 'DBA-STD', owner: 'Lead Database Administrator', subject: 'database high availability', tags: ['availability', 'standby'] },

  // Enterprise Applications
  { title: 'ERP Release Management Procedure', department: 'Enterprise Applications', documentType: 'PROCEDURE', category: 'ERP', codePrefix: 'ERP-PROC', owner: 'Head of Enterprise Applications', subject: 'ERP release management', tags: ['erp', 'release'] },
  { title: 'Integration Standard', department: 'Enterprise Applications', documentType: 'STANDARD', category: 'Integration', codePrefix: 'ERP-STD', owner: 'Integration Architect', subject: 'system integration design', tags: ['integration', 'api'] },
  { title: 'Master Data Management Policy', department: 'Enterprise Applications', documentType: 'POLICY', category: 'Data', codePrefix: 'ERP-POL', owner: 'Master Data Manager', subject: 'master data governance', tags: ['master data', 'governance'] },
  { title: 'ERP User Manual', department: 'Enterprise Applications', documentType: 'MANUAL', category: 'ERP', codePrefix: 'ERP-MAN', owner: 'Head of Enterprise Applications', subject: 'day to day ERP usage', tags: ['erp', 'manual'] },
  { title: 'Reporting and Analytics Guideline', department: 'Enterprise Applications', documentType: 'GUIDELINE', category: 'Reporting', codePrefix: 'ERP-GUIDE', owner: 'Head of Business Intelligence', subject: 'operational reporting', tags: ['reporting', 'analytics'] },
];

/**
 * Facts every generated blueprint asserts. Kept uniform so the evaluation
 * generator can produce questions for any of them without special cases.
 */
function genericFacts() {
  return [
    fact('approvalThreshold', 'Approval threshold', 'requirements', money(2500, 75000, 2500)),
    fact('reviewCycle', 'Review cycle', 'governance', months(6, 36)),
    fact('responseTime', 'Response time', 'requirements', businessDays(1, 15)),
    fact('retentionPeriod', 'Record retention period', 'records', years(2, 10)),
    fact('trainingFrequency', 'Mandatory training frequency', 'governance', months(6, 24)),
    fact('complianceTarget', 'Compliance target', 'measurement', percent(85, 99, 1)),
    fact('escalationTime', 'Escalation time', 'escalation', hours(2, 48)),
    fact('auditSample', 'Audit sample size', 'measurement', count(10, 60, 'records per quarter')),
    fact('exceptionValidity', 'Exception validity', 'governance', days(30, 365)),
  ];
}

function makeGenericBlueprint(topic: TopicSpec): Blueprint {
  return {
    key: `generic-${topic.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    codePrefix: topic.codePrefix,
    title: topic.title,
    department: topic.department,
    documentType: topic.documentType,
    category: topic.category,
    ownerRole: topic.owner,
    tags: topic.tags,
    description: `Defines the requirements, responsibilities and controls that apply to ${topic.subject}.`,
    purpose: `This document defines how ${topic.subject} is carried out, and the controls that apply to it.`,
    scope: `This document applies to all employees and contractors involved in ${topic.subject}, and to any supplier performing it on the organisation's behalf.`,
    facts: genericFacts(),

    build(context) {
      const { f } = context;
      const subject = topic.subject;
      return [
        {
          key: 'requirements',
          title: 'Requirements',
          paragraphs: [
            `All activity relating to ${subject} must follow the requirements set out in this document. ` +
              `Where a commitment or change exceeds ${f('approvalThreshold')} in value, approval must be ` +
              `obtained from the ${topic.owner} before the activity proceeds.`,
            `Requests raised under this document receive a substantive response within ${f('responseTime')}. ` +
              'A request that cannot be met within that period receives an interim response stating what ' +
              'is outstanding and when it will be resolved.',
          ],
          bullets: [
            `Activity relating to ${subject} is recorded in the system of record at the time it occurs.`,
            'Requirements apply equally to work performed by suppliers on the organisation’s behalf.',
            'Where a requirement conflicts with a legal obligation, the legal obligation takes precedence ' +
              'and the conflict is reported to Compliance.',
          ],
        },
        {
          key: 'process',
          title: 'Process',
          paragraphs: [
            `The following steps apply to ${subject}. Steps are performed in sequence; where a step is ` +
              'skipped, the reason is recorded against the request.',
          ],
          steps: [
            `Identify the requirement and confirm it falls within the scope of ${subject}.`,
            'Record the request in the system of record with the responsible owner named.',
            `Obtain approval where the value or impact exceeds ${f('approvalThreshold')}.`,
            'Carry out the activity in line with the requirements in this document.',
            'Record the outcome, including any deviation and the reason for it.',
            'Confirm completion with the requester and close the record.',
          ],
        },
        {
          key: 'escalation',
          title: 'Escalation',
          paragraphs: [
            `Where a request cannot be progressed, it is escalated to the ${topic.owner} within ` +
              `${f('escalationTime')}. Escalation includes what was attempted and what is blocking ` +
              'progress, so the receiving party does not have to reconstruct the history.',
          ],
        },
        {
          key: 'records',
          title: 'Records',
          paragraphs: [
            `Records created under this document are retained for ${f('retentionPeriod')} from the end of ` +
              'the year in which the activity completed, unless a longer statutory period applies.',
          ],
        },
        {
          key: 'measurement',
          title: 'Measurement',
          paragraphs: [
            `Compliance with this document is measured quarterly against a target of ` +
              `${f('complianceTarget')}. An audit sample of ${f('auditSample')} is reviewed to confirm ` +
              'the control is operating as designed.',
          ],
          table: {
            caption: 'Control measures',
            header: ['Measure', 'Target', 'Frequency'],
            rows: [
              ['Compliance rate', f('complianceTarget'), 'Quarterly'],
              ['Audit sample', f('auditSample'), 'Quarterly'],
              ['Response time', f('responseTime'), 'Per request'],
            ],
          },
        },
        {
          key: 'governance',
          title: 'Governance',
          paragraphs: [
            `This document is reviewed every ${f('reviewCycle')} by the ${topic.owner}. Employees involved ` +
              `in ${subject} complete mandatory training every ${f('trainingFrequency')}.`,
            `An approved exception to this document is valid for ${f('exceptionValidity')} and is recorded ` +
              'in the governance register with its business justification.',
          ],
        },
        definitionsSection([
          ['System of record', 'the authoritative system in which activity under this document is logged'],
          ['Owner', 'the named role accountable for the outcome of an activity'],
          ['Exception', 'an approved, time-limited deviation from a requirement in this document'],
        ]),
        responsibilitiesSection([
          [topic.owner, 'Owns this document, approves exceptions and reviews it at the stated interval'],
          ['Line Manager', 'Ensures their team follows these requirements and completes mandatory training'],
          ['All Users', `Follows this document when involved in ${subject} and reports deviations`],
          ['Internal Audit', 'Independently tests whether the controls described here operate as designed'],
        ]),
        exceptionsSection(topic.owner, `${f('exceptionValidity')} from approval`),
        complianceSection('at the stated review interval', topic.owner),
        relatedDocumentsSection([
          'Information Classification Policy',
          'Change Management Standard',
          'Data Retention and Disposal Standard',
        ]),
      ];
    },

    questions(context) {
      const { f, title } = context;
      return [
        {
          type: 'DIRECT' as const,
          question: `What approval threshold applies under the ${title}?`,
          sectionKey: 'requirements',
          factIds: ['approvalThreshold'],
          referenceAnswer: `Approval from the ${topic.owner} is required where the value exceeds ${f('approvalThreshold')}.`,
        },
        {
          type: 'DIRECT' as const,
          question: `How long are records retained under the ${title}?`,
          sectionKey: 'records',
          factIds: ['retentionPeriod'],
          referenceAnswer: `Records are retained for ${f('retentionPeriod')} from the end of the year in which the activity completed.`,
        },
        {
          type: 'PARAPHRASE' as const,
          question: `How often is the ${title} reviewed?`,
          sectionKey: 'governance',
          factIds: ['reviewCycle'],
          referenceAnswer: `The document is reviewed every ${f('reviewCycle')} by the ${topic.owner}.`,
        },
      ];
    },
  };
}

export const genericBlueprints: Blueprint[] = TOPICS.map(makeGenericBlueprint);

/** Suffixes used to derive further distinct documents at scale. */
export const SCALE_VARIANTS = [
  'EMEA Addendum',
  'Americas Addendum',
  'APAC Addendum',
  'Shared Services Supplement',
  'Manufacturing Supplement',
  'Retail Operations Supplement',
  'Subsidiary Implementation Guide',
  'Regional Interpretation Note',
] as const;
