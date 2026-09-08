/**
 * Finance blueprints.
 *
 * The expense policy is the corpus' reference document for the revision demo:
 * its approval thresholds are the facts that change between revision 1 and 2,
 * so "what expenses require Finance Director approval?" must return a different
 * answer once the new revision is activated.
 */

import {
  APPROVAL_ROLES,
  businessDays,
  calendarDays,
  choice,
  complianceSection,
  definitionsSection,
  exceptionsSection,
  fact,
  money,
  percent,
  relatedDocumentsSection,
  responsibilitiesSection,
  type Blueprint,
} from './shared.js';

export const businessExpensePolicy: Blueprint = {
  key: 'business-expense-policy',
  codePrefix: 'FIN-POL',
  title: 'Business Expense Policy',
  department: 'Finance',
  documentType: 'POLICY',
  category: 'Expenses',
  ownerRole: 'Finance Director',
  tags: ['expenses', 'reimbursement', 'approval', 'travel'],
  description:
    'Defines which business expenses may be incurred, the approval required at each value band, and how ' +
    'reimbursement claims are submitted and settled.',
  purpose:
    'This policy establishes the rules under which employees and contractors may incur business expenses on ' +
    'behalf of the organisation, and the approvals required before those expenses are committed.',
  scope:
    'This policy applies to all employees, contractors and secondees who incur expenditure that is settled by ' +
    'the organisation, whether paid by corporate card, personal funds or direct supplier invoice.',

  facts: [
    fact('managerThreshold', 'Departmental manager approval limit', 'approval-requirements', money(1000, 5000, 500)),
    fact('financeDirectorThreshold', 'Finance Director approval threshold', 'approval-requirements', money(10000, 30000, 2500)),
    fact('cfoThreshold', 'Chief Financial Officer approval threshold', 'approval-requirements', money(50000, 150000, 10000)),
    fact('receiptThreshold', 'Receipt requirement threshold', 'documentation', money(25, 75, 5)),
    fact('submissionWindow', 'Claim submission window', 'submission', calendarDays(30, 90)),
    fact('settlementWindow', 'Reimbursement settlement period', 'submission', businessDays(5, 15)),
    fact('mileageRate', 'Mileage reimbursement rate', 'allowances', (rng) => {
      const cents = rng.int(45, 70);
      return { value: `$0.${cents} per mile`, numericValue: cents, unit: 'cents per mile' };
    }),
    fact('perDiem', 'International per diem allowance', 'allowances', money(60, 140, 5)),
    fact('cardLimit', 'Standard corporate card monthly limit', 'allowances', money(2500, 10000, 500)),
    fact('auditSample', 'Monthly audit sample rate', 'compliance-checks', percent(5, 20, 1)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'policy-statement',
        title: 'Policy Statement',
        paragraphs: [
          'Business expenses must be necessary, reasonable, and directly related to the performance of ' +
            'assigned duties. Expenditure that is primarily personal in nature is not reimbursable, ' +
            'regardless of the value involved.',
          'All expenditure must be approved before it is committed. Where an expense is incurred without ' +
            'prior approval, the claimant must provide a written explanation, and settlement is at the ' +
            'discretion of the approving authority.',
        ],
        bullets: [
          'Expenses must be recorded against the cost centre that receives the benefit.',
          'Splitting a single commitment into smaller claims to remain below an approval threshold is a ' +
            'breach of this policy.',
          'Alcohol, personal entertainment, traffic fines and personal travel upgrades are not reimbursable.',
        ],
      },
      {
        key: 'approval-requirements',
        title: 'Approval Requirements',
        paragraphs: [
          `Approval authority is determined by the total value of the commitment. A departmental manager ` +
            `may approve business expenses up to ${f('managerThreshold')}. Expenditure above that value, and ` +
            `up to ${f('financeDirectorThreshold')}, requires the approval of the Finance Director.`,
          `Any single expense at or above ${f('financeDirectorThreshold')} requires Finance Director ` +
            `approval before the commitment is made. Expenditure above ${f('cfoThreshold')} additionally ` +
            'requires the approval of the Chief Financial Officer, and is reported to the Audit Committee ' +
            'at its next scheduled meeting.',
          'Approval authority may not be delegated below the level stated in this section. Where an ' +
            'approver is unavailable, the next higher authority approves in their place.',
        ],
        table: {
          caption: 'Expense approval authority',
          header: ['Expenditure value', 'Required approver', 'Supporting evidence'],
          rows: [
            [`Up to ${f('managerThreshold')}`, 'Departmental Manager', 'Itemised receipt'],
            [
              `Above ${f('managerThreshold')} up to ${f('financeDirectorThreshold')}`,
              'Finance Director',
              'Itemised receipt and business justification',
            ],
            [
              `Above ${f('financeDirectorThreshold')} up to ${f('cfoThreshold')}`,
              'Finance Director and Head of Department',
              'Business case and quotation',
            ],
            [`Above ${f('cfoThreshold')}`, 'Chief Financial Officer', 'Business case and competitive quotations'],
          ],
        },
      },
      {
        key: 'documentation',
        title: 'Documentation and Evidence',
        paragraphs: [
          `An itemised receipt is required for every expense at or above ${f('receiptThreshold')}. Card ` +
            'statements are not accepted as evidence because they do not show what was purchased.',
          'Where a receipt has been lost, the claimant must complete a missing receipt declaration ' +
            'countersigned by their manager. Repeated declarations are reviewed by Finance.',
        ],
      },
      {
        key: 'submission',
        title: 'Claim Submission and Settlement',
        paragraphs: [
          `Claims must be submitted within ${f('submissionWindow')} of the date the expense was incurred. ` +
            'Claims submitted after this period require Finance Director approval and a written explanation ' +
            'of the delay.',
          `Approved claims are settled within ${f('settlementWindow')} of approval, through the payroll ` +
            'settlement run for employees and through accounts payable for contractors.',
        ],
        steps: [
          'Record the expense in the expense management system, attaching itemised evidence.',
          'Select the cost centre and project code that receives the benefit of the expenditure.',
          'Submit the claim for approval by the authority appropriate to its value.',
          'The approver reviews the claim, and either approves it, returns it for correction, or rejects it ' +
            'with a documented reason.',
          'Finance validates coding and tax treatment before releasing the claim for settlement.',
        ],
      },
      {
        key: 'allowances',
        title: 'Standard Allowances',
        paragraphs: [
          `Travel by personal vehicle is reimbursed at ${f('mileageRate')}, which is inclusive of fuel, ` +
            'insurance and wear. Journeys must be recorded with start and end locations.',
          `The international per diem allowance is ${f('perDiem')} per full day of travel, covering meals ` +
            'and incidental costs. Where a meal is provided by the host, the per diem is reduced ' +
            'proportionally.',
          `The standard corporate card monthly limit is ${f('cardLimit')}. Temporary limit increases are ` +
            'approved by the Finance Director for a defined period.',
        ],
      },
      {
        key: 'contractors',
        title: 'Contractors and Non-Employees',
        paragraphs: [
          'Contractors may claim only those expenses that are expressly provided for in their engagement ' +
            'contract. Relocation expenses, professional subscriptions and training costs are not ' +
            'reimbursable for contractors under any circumstances.',
          'Where a contractor incurs an expense on behalf of the organisation, the engaging manager is ' +
            'accountable for confirming that the expense falls within the contracted scope.',
        ],
      },
      {
        key: 'compliance-checks',
        title: 'Compliance Checks',
        paragraphs: [
          `Finance audits a random sample of ${f('auditSample')} of settled claims each month. Claims ` +
            'selected for audit are reviewed against the evidence attached at submission.',
          'Where an audit identifies a breach, the claim is recovered through payroll and the matter is ' +
            'referred to the employee’s manager.',
        ],
      },
      definitionsSection([
        ['Business expense', 'expenditure necessarily incurred in the performance of assigned duties'],
        ['Commitment', 'the point at which the organisation becomes liable for a cost, including a verbal order'],
        ['Itemised receipt', 'evidence showing the supplier, date, individual items purchased and total paid'],
        ['Per diem', 'a fixed daily allowance paid in place of itemised meal and incidental claims'],
      ]),
      responsibilitiesSection([
        ['Claimant', 'Ensures the expense is necessary, correctly coded and supported by evidence'],
        ['Departmental Manager', 'Approves expenditure within delegated authority and validates business need'],
        ['Finance Director', 'Approves expenditure above the departmental limit and owns this policy'],
        ['Accounts Payable', 'Validates coding and tax treatment and executes settlement'],
        ['Internal Audit', 'Performs independent sampling and reports breaches to the Audit Committee'],
      ]),
      exceptionsSection('Finance Director', 'the remainder of the current financial year'),
      complianceSection('annually', 'Finance Director'),
      relatedDocumentsSection([
        'Expense Approval Procedure',
        'Employee Travel Policy',
        'Vendor Procurement Policy',
        'Delegation of Authority Framework',
      ]),
    ];
  },

  questions(context) {
    const { f, documentCode } = context;
    return [
      {
        type: 'DIRECT',
        question: 'What expense amount requires Finance Director approval?',
        sectionKey: 'approval-requirements',
        factIds: ['financeDirectorThreshold'],
        referenceAnswer: `Expenditure at or above ${f('financeDirectorThreshold')} requires Finance Director approval before the commitment is made.`,
      },
      {
        type: 'DIRECT',
        question: 'What is the approval limit for departmental managers?',
        sectionKey: 'approval-requirements',
        factIds: ['managerThreshold'],
        referenceAnswer: `A departmental manager may approve business expenses up to ${f('managerThreshold')}.`,
      },
      {
        type: 'PARAPHRASE',
        question: 'How much can my line manager sign off on before it has to go to Finance?',
        sectionKey: 'approval-requirements',
        factIds: ['managerThreshold', 'financeDirectorThreshold'],
        referenceAnswer: `A departmental manager can approve up to ${f('managerThreshold')}; above that, and up to ${f('financeDirectorThreshold')}, the Finance Director must approve.`,
      },
      {
        type: 'DIRECT',
        question: 'How long do I have to submit an expense claim?',
        sectionKey: 'submission',
        factIds: ['submissionWindow'],
        referenceAnswer: `Claims must be submitted within ${f('submissionWindow')} of the date the expense was incurred.`,
      },
      {
        type: 'TERMINOLOGY',
        question: 'What is the international per diem allowance for business travel?',
        sectionKey: 'allowances',
        factIds: ['perDiem'],
        referenceAnswer: `The international per diem allowance is ${f('perDiem')} per full day of travel.`,
      },
      {
        type: 'DIRECT',
        question: 'Can contractors claim relocation expenses?',
        sectionKey: 'contractors',
        factIds: [],
        referenceAnswer:
          'No. Relocation expenses, professional subscriptions and training costs are not reimbursable for contractors.',
      },
      {
        type: 'IDENTIFIER',
        question: `What approval thresholds does ${documentCode} define for business expenditure?`,
        sectionKey: 'approval-requirements',
        factIds: ['managerThreshold', 'financeDirectorThreshold'],
        referenceAnswer: `${documentCode} sets a departmental manager limit of ${f('managerThreshold')} and requires Finance Director approval at or above ${f('financeDirectorThreshold')}.`,
      },
      {
        type: 'REVISION_SENSITIVE',
        question: 'What is the current Finance Director approval threshold for a single expense?',
        sectionKey: 'approval-requirements',
        factIds: ['financeDirectorThreshold'],
        referenceAnswer: `The current threshold is ${f('financeDirectorThreshold')}.`,
      },
      {
        type: 'CROSS_SECTION',
        question: 'What evidence do I need for a large expense and who has to approve it?',
        sectionKey: 'approval-requirements',
        factIds: ['receiptThreshold', 'financeDirectorThreshold'],
        referenceAnswer: `An itemised receipt is required at or above ${f('receiptThreshold')}, and expenditure at or above ${f('financeDirectorThreshold')} requires Finance Director approval with a business justification.`,
      },
    ];
  },
};

export const expenseApprovalProcedure: Blueprint = {
  key: 'expense-approval-procedure',
  codePrefix: 'FIN-PROC',
  title: 'Expense Approval Procedure',
  department: 'Finance',
  documentType: 'PROCEDURE',
  category: 'Expenses',
  ownerRole: 'Head of Financial Control',
  tags: ['expenses', 'procedure', 'approval', 'workflow'],
  description:
    'Step-by-step procedure for routing, reviewing and settling an expense claim, including escalation when ' +
    'an approver does not respond.',
  purpose:
    'This procedure describes how an expense claim moves from submission to settlement, and what each ' +
    'participant must do at each step.',
  scope:
    'This procedure applies to every expense claim raised in the expense management system, including claims ' +
    'raised on behalf of another employee.',

  facts: [
    fact('approverSla', 'Approver response time', 'approval-steps', businessDays(2, 5)),
    fact('escalationWindow', 'Escalation trigger', 'escalation', businessDays(3, 8)),
    fact('queryWindow', 'Claimant response window for queries', 'escalation', businessDays(3, 10)),
    fact('batchDay', 'Weekly settlement run', 'settlement', choice(['Tuesday', 'Wednesday', 'Thursday'])),
    fact('spotCheck', 'Pre-settlement spot check rate', 'settlement', percent(3, 12, 1)),
    fact('escalationApprover', 'Escalation authority', 'escalation', choice(APPROVAL_ROLES)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'approval-steps',
        title: 'Approval Steps',
        paragraphs: [
          `Each claim is routed to a single approver based on its value and the claimant’s reporting ` +
            `line. The approver is expected to act within ${f('approverSla')} of receiving the claim.`,
        ],
        steps: [
          'The claimant submits the claim with itemised evidence attached to every line.',
          'The system validates cost centre, project code and tax treatment, rejecting incomplete claims ' +
            'immediately.',
          'The claim is routed to the approver whose delegated authority covers the claim value.',
          'The approver reviews the business justification and either approves, queries or rejects the claim.',
          'Approved claims are queued for the next settlement run; rejected claims return to the claimant ' +
            'with a documented reason.',
        ],
      },
      {
        key: 'escalation',
        title: 'Escalation',
        paragraphs: [
          `Where an approver has not acted within ${f('escalationWindow')}, the claim is escalated ` +
            `automatically to the ${f('escalationApprover')}, and the original approver is notified.`,
          `Where the approver raises a query, the claimant has ${f('queryWindow')} to respond. A claim that ` +
            'receives no response within that period is returned to draft and must be resubmitted.',
        ],
      },
      {
        key: 'settlement',
        title: 'Settlement',
        paragraphs: [
          `Settlement runs execute weekly on ${f('batchDay')}. Claims approved after the run has started ` +
            'are carried to the following week.',
          `Finance performs a pre-settlement spot check on ${f('spotCheck')} of the batch, focusing on ` +
            'claims that were escalated or approved outside the standard routing.',
        ],
      },
      responsibilitiesSection([
        ['Claimant', 'Submits complete and accurate claims and responds to queries within the stated window'],
        ['Approver', 'Reviews and decides claims within the response time and records the reason for rejection'],
        ['Financial Control', 'Operates the settlement run and performs pre-settlement spot checks'],
        ['System Administrator', 'Maintains routing rules so claims reach the correct delegated authority'],
      ]),
      exceptionsSection('Head of Financial Control', 'a single settlement cycle'),
      relatedDocumentsSection(['Business Expense Policy', 'Delegation of Authority Framework']),
    ];
  },

  workflow(context) {
    const { f } = context;
    return {
      title: 'Expense claim approval workflow',
      nodes: [
        'Expense Claim Submitted',
        'System Validation',
        'Manager Approval',
        `Finance Review (${f('spotCheck')} sample)`,
        'Settlement Run',
        'Payment to Claimant',
      ],
      expectedText:
        'Expense Claim Submitted -> System Validation -> Manager Approval -> Finance Review -> ' +
        'Settlement Run -> Payment to Claimant',
    };
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'How long does an approver have to act on an expense claim?',
        sectionKey: 'approval-steps',
        factIds: ['approverSla'],
        referenceAnswer: `The approver is expected to act within ${f('approverSla')} of receiving the claim.`,
      },
      {
        type: 'DIRECT',
        question: 'When is an unapproved expense claim escalated?',
        sectionKey: 'escalation',
        factIds: ['escalationWindow'],
        referenceAnswer: `A claim not acted on within ${f('escalationWindow')} is escalated automatically to the ${f('escalationApprover')}.`,
      },
      {
        type: 'PARAPHRASE',
        question: 'What day of the week are expense reimbursements paid out?',
        sectionKey: 'settlement',
        factIds: ['batchDay'],
        referenceAnswer: `Settlement runs execute weekly on ${f('batchDay')}.`,
      },
    ];
  },
};

export const financeBlueprints: Blueprint[] = [businessExpensePolicy, expenseApprovalProcedure];
