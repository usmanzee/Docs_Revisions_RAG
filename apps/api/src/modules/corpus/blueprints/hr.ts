/** Human Resources blueprints: leave, remote working and employee travel. */

import {
  businessDays,
  calendarDays,
  choice,
  complianceSection,
  count,
  days,
  definitionsSection,
  exceptionsSection,
  fact,
  hours,
  money,
  months,
  relatedDocumentsSection,
  responsibilitiesSection,
  weeks,
  type Blueprint,
} from './shared.js';

export const annualLeavePolicy: Blueprint = {
  key: 'annual-leave-policy',
  codePrefix: 'HR-POL',
  title: 'Annual Leave Policy',
  department: 'Human Resources',
  documentType: 'POLICY',
  category: 'Leave and Absence',
  ownerRole: 'Head of Human Resources',
  tags: ['leave', 'entitlement', 'absence', 'holiday'],
  description:
    'Sets out annual leave entitlement, how leave is requested and approved, carry-over rules and the ' +
    'treatment of leave on joining and leaving.',
  purpose:
    'This policy defines paid annual leave entitlement and the rules under which leave is requested, ' +
    'approved, carried over and paid.',
  scope:
    'This policy applies to all permanent and fixed-term employees. Contractors and agency workers are ' +
    'covered by the terms of their engagement rather than by this policy.',

  facts: [
    fact('standardEntitlement', 'Standard annual leave entitlement', 'entitlement', days(20, 28)),
    fact('seniorEntitlement', 'Senior grade entitlement', 'entitlement', days(26, 34)),
    fact('longServiceBonus', 'Long service additional days', 'entitlement', count(1, 5, 'additional days')),
    fact('longServiceYears', 'Long service qualifying period', 'entitlement', count(3, 10, 'years of service')),
    fact('carryOverLimit', 'Maximum carry-over', 'carry-over', days(5, 12)),
    fact('carryOverDeadline', 'Carry-over expiry', 'carry-over', months(3, 9)),
    fact('noticeShort', 'Notice for leave up to five days', 'requesting-leave', calendarDays(7, 21)),
    fact('noticeLong', 'Notice for leave over five days', 'requesting-leave', calendarDays(21, 60)),
    fact('maxConsecutive', 'Maximum consecutive leave', 'requesting-leave', weeks(2, 4)),
    fact('approverResponse', 'Manager response time', 'requesting-leave', businessDays(3, 10)),
    fact('probationRestriction', 'Probation leave restriction', 'joining-leaving', months(3, 6)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'entitlement',
        title: 'Annual Leave Entitlement',
        paragraphs: [
          `The standard annual leave entitlement is ${f('standardEntitlement')} per full leave year, ` +
            'exclusive of public holidays. Entitlement accrues monthly and is pro-rated for part-time ' +
            'employees on the basis of contracted hours.',
          `Employees at senior grades receive ${f('seniorEntitlement')} per leave year. After ` +
            `${f('longServiceYears')}, employees receive ${f('longServiceBonus')} in recognition of long ` +
            'service, applied from the start of the following leave year.',
        ],
        table: {
          caption: 'Entitlement by grade',
          header: ['Grade', 'Annual entitlement', 'Accrual'],
          rows: [
            ['Standard grades', f('standardEntitlement'), 'Monthly, pro-rated'],
            ['Senior grades', f('seniorEntitlement'), 'Monthly, pro-rated'],
            [`After ${f('longServiceYears')}`, `+ ${f('longServiceBonus')}`, 'From the next leave year'],
          ],
        },
      },
      {
        key: 'requesting-leave',
        title: 'Requesting and Approving Leave',
        paragraphs: [
          `Leave of up to five working days requires at least ${f('noticeShort')} notice. Leave of more ` +
            `than five working days requires at least ${f('noticeLong')} notice so that cover can be ` +
            'arranged.',
          `Managers must respond to a leave request within ${f('approverResponse')}. Where a request is ` +
            'declined, the manager must record the operational reason and, where possible, offer ' +
            'alternative dates.',
          `No employee may take more than ${f('maxConsecutive')} of consecutive annual leave without the ` +
            'written approval of their department head.',
        ],
        steps: [
          'Check remaining entitlement and team coverage in the absence calendar.',
          'Submit the request through the HR system, stating the first and last day of absence.',
          'The line manager reviews the request against operational cover and approves or declines it.',
          'Approved leave is recorded against entitlement and published to the team calendar.',
          'Where leave is declined, the manager records the reason and proposes alternative dates.',
        ],
      },
      {
        key: 'carry-over',
        title: 'Carry-Over',
        paragraphs: [
          `Up to ${f('carryOverLimit')} of unused entitlement may be carried into the next leave year. ` +
            `Carried-over leave must be taken within ${f('carryOverDeadline')} of the start of the new leave ` +
            'year, after which it lapses without payment.',
          'Carry-over above this limit is approved only where the employee was prevented from taking leave ' +
            'by documented operational demand, long-term sickness or statutory family leave.',
        ],
      },
      {
        key: 'joining-leaving',
        title: 'Joining and Leaving',
        paragraphs: [
          `New employees accrue leave from their start date but may not normally take annual leave during ` +
            `their first ${f('probationRestriction')} of employment, except with the approval of their ` +
            'department head.',
          'On leaving, accrued and untaken leave is paid in the final salary payment. Leave taken in excess ' +
            'of accrued entitlement is recovered from final pay.',
        ],
      },
      definitionsSection([
        ['Leave year', 'the twelve-month period over which entitlement is calculated and reset'],
        ['Accrual', 'the monthly building of entitlement across the leave year'],
        ['Carry-over', 'unused entitlement moved into the following leave year within the stated limit'],
      ]),
      responsibilitiesSection([
        ['Employee', 'Plans leave with adequate notice and records absence accurately'],
        ['Line Manager', 'Balances requests against operational cover and responds within the stated period'],
        ['Human Resources', 'Maintains entitlement records and advises on complex or contested cases'],
        ['Payroll', 'Settles accrued and untaken leave on termination'],
      ]),
      exceptionsSection('Head of Human Resources', 'the current leave year'),
      complianceSection('annually', 'Head of Human Resources'),
      relatedDocumentsSection(['Remote Work Policy', 'Employee Travel Policy', 'Sickness Absence Procedure']),
    ];
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'What is the standard annual leave entitlement?',
        sectionKey: 'entitlement',
        factIds: ['standardEntitlement'],
        referenceAnswer: `The standard annual leave entitlement is ${f('standardEntitlement')} per full leave year, excluding public holidays.`,
      },
      {
        type: 'DIRECT',
        question: 'How many days of annual leave can be carried over to the next year?',
        sectionKey: 'carry-over',
        factIds: ['carryOverLimit'],
        referenceAnswer: `Up to ${f('carryOverLimit')} may be carried over, and must be used within ${f('carryOverDeadline')} of the new leave year.`,
      },
      {
        type: 'PARAPHRASE',
        question: 'How much notice do I need to give for a two week holiday?',
        sectionKey: 'requesting-leave',
        factIds: ['noticeLong'],
        referenceAnswer: `Leave of more than five working days requires at least ${f('noticeLong')} notice.`,
      },
      {
        type: 'CROSS_SECTION',
        question: 'Can a new joiner take annual leave immediately, and how much notice is needed?',
        sectionKey: 'joining-leaving',
        factIds: ['probationRestriction', 'noticeShort'],
        referenceAnswer: `Leave is not normally taken during the first ${f('probationRestriction')} of employment, and short leave requires ${f('noticeShort')} notice.`,
      },
    ];
  },
};

export const remoteWorkPolicy: Blueprint = {
  key: 'remote-work-policy',
  codePrefix: 'HR-POL',
  title: 'Remote Work Policy',
  department: 'Human Resources',
  documentType: 'POLICY',
  category: 'Working Arrangements',
  ownerRole: 'Head of Human Resources',
  tags: ['remote', 'hybrid', 'vpn', 'working arrangements'],
  description:
    'Defines eligibility for remote and hybrid working, the security conditions that apply, and the ' +
    'expectations placed on remote employees and their managers.',
  purpose:
    'This policy sets out when employees may work away from a company office, and the conditions that must ' +
    'be met for remote working to be approved and maintained.',
  scope:
    'This policy applies to all employees whose role can be performed away from a company location. Roles ' +
    'requiring physical presence are excluded and are listed by each department head.',

  facts: [
    fact('officeDays', 'Minimum office attendance', 'eligibility', count(1, 4, 'days per week')),
    fact('eligibilityService', 'Service required before remote working', 'eligibility', months(0, 12)),
    fact('reviewPeriod', 'Arrangement review period', 'eligibility', months(6, 18)),
    fact('coreHoursStart', 'Core hours start', 'availability', choice(['09:00', '09:30', '10:00'])),
    fact('coreHoursEnd', 'Core hours end', 'availability', choice(['15:00', '15:30', '16:00'])),
    fact('responseTime', 'Expected response time during core hours', 'availability', hours(1, 4)),
    fact('vpnRequirement', 'Network access requirement', 'security', choice(['corporate VPN'])),
    fact('sessionTimeout', 'Remote session inactivity timeout', 'security', count(10, 30, 'minutes')),
    fact('equipmentAllowance', 'Home office equipment allowance', 'equipment', money(200, 900, 50)),
    fact('internetSpeed', 'Minimum broadband speed', 'equipment', count(20, 100, 'Mbps')),
    fact('internationalLimit', 'Overseas remote working limit', 'international', days(10, 30)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'eligibility',
        title: 'Eligibility',
        paragraphs: [
          `Remote working is available to employees whose role can be performed effectively away from a ` +
            `company location, subject to a minimum office attendance of ${f('officeDays')}. Attendance ` +
            'days are agreed with the line manager and published to the team.',
          `Employees become eligible after ${f('eligibilityService')} of service. Each arrangement is ` +
            `reviewed every ${f('reviewPeriod')}, or sooner where performance or business need changes.`,
        ],
      },
      {
        key: 'availability',
        title: 'Availability and Working Hours',
        paragraphs: [
          `Remote employees must be contactable during core hours of ${f('coreHoursStart')} to ` +
            `${f('coreHoursEnd')} local time, and are expected to respond to messages within ` +
            `${f('responseTime')} during that window.`,
          'Working patterns outside core hours are agreed in advance with the line manager and recorded in ' +
            'the team calendar.',
        ],
      },
      {
        key: 'security',
        title: 'Information Security Requirements',
        paragraphs: [
          `All remote access to internal systems must be made through the ${f('vpnRequirement')}. ` +
            'Connecting to internal systems from a public or untrusted network without it is a security ' +
            'breach and is treated under the information security policy.',
          `Devices used for remote work must lock automatically after ${f('sessionTimeout')} of inactivity, ` +
            'run full-disk encryption, and receive security updates through the managed device service.',
          'Company information must not be stored on personal devices or personal cloud storage. Printing ' +
            'of confidential material outside a company location is not permitted.',
        ],
        bullets: [
          'Use the corporate VPN for every connection to an internal system.',
          'Keep the workstation locked when unattended, including at home.',
          'Report a lost or stolen device to the service desk immediately.',
          'Do not allow family members or housemates to use a company device.',
        ],
      },
      {
        key: 'equipment',
        title: 'Equipment and Workspace',
        paragraphs: [
          `A one-off home office equipment allowance of ${f('equipmentAllowance')} is available to ` +
            'employees on an approved remote arrangement, claimed through the expense process.',
          `Employees are responsible for maintaining a broadband connection of at least ` +
            `${f('internetSpeed')} and a workspace that meets basic display screen equipment guidance.`,
        ],
      },
      {
        key: 'international',
        title: 'Working Outside the Country of Employment',
        paragraphs: [
          `Working from another country is permitted for no more than ${f('internationalLimit')} in a ` +
            'rolling twelve-month period, and requires approval from both the line manager and Human ' +
            'Resources before travel.',
          'Approval is refused where the arrangement would create a tax, immigration or data residency ' +
            'exposure for the organisation.',
        ],
      },
      responsibilitiesSection([
        ['Employee', 'Maintains a secure workspace, uses the VPN and remains contactable during core hours'],
        ['Line Manager', 'Agrees the arrangement, sets attendance days and reviews it at the stated interval'],
        ['Information Security', 'Defines the technical controls applied to remote devices'],
        ['Human Resources', 'Approves international arrangements and maintains policy records'],
      ]),
      exceptionsSection('Head of Human Resources', 'six months'),
      relatedDocumentsSection([
        'Password Security Policy',
        'Information Classification Policy',
        'Annual Leave Policy',
      ]),
    ];
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'How must remote employees connect to internal systems?',
        sectionKey: 'security',
        factIds: [],
        referenceAnswer: `All remote access to internal systems must be made through the ${f('vpnRequirement')}.`,
      },
      {
        type: 'DIRECT',
        question: 'How many days per week must employees attend the office?',
        sectionKey: 'eligibility',
        factIds: ['officeDays'],
        referenceAnswer: `Remote working is subject to a minimum office attendance of ${f('officeDays')}.`,
      },
      {
        type: 'DIRECT',
        question: 'How long can an employee work from another country?',
        sectionKey: 'international',
        factIds: ['internationalLimit'],
        referenceAnswer: `Working from another country is permitted for no more than ${f('internationalLimit')} in a rolling twelve-month period, with prior approval.`,
      },
      {
        type: 'TERMINOLOGY',
        question: 'What are the core hours for remote workers?',
        sectionKey: 'availability',
        factIds: ['coreHoursStart', 'coreHoursEnd'],
        referenceAnswer: `Core hours are ${f('coreHoursStart')} to ${f('coreHoursEnd')} local time.`,
      },
    ];
  },
};

export const employeeTravelPolicy: Blueprint = {
  key: 'employee-travel-policy',
  codePrefix: 'HR-POL',
  title: 'Employee Travel Policy',
  department: 'Human Resources',
  documentType: 'POLICY',
  category: 'Travel',
  ownerRole: 'Head of Human Resources',
  tags: ['travel', 'booking', 'approval', 'safety'],
  description:
    'Governs business travel booking, class of travel, approval thresholds and traveller safety obligations.',
  purpose:
    'This policy defines how business travel is authorised and booked, and the standards that apply to ' +
    'travel class, accommodation and traveller safety.',
  scope:
    'This policy applies to all business travel undertaken on behalf of the organisation, including travel ' +
    'booked by a third party on an employee’s behalf.',

  facts: [
    fact('advanceBooking', 'Advance booking requirement', 'booking', calendarDays(7, 28)),
    fact('financeApprovalThreshold', 'Finance approval threshold for travel', 'authorisation', money(2000, 10000, 500)),
    fact('businessClassHours', 'Business class eligibility', 'travel-class', hours(5, 10)),
    fact('hotelCap', 'Nightly accommodation cap', 'accommodation', money(120, 320, 10)),
    fact('safetyRegistration', 'Traveller registration deadline', 'safety', businessDays(1, 5)),
    fact('highRiskApprover', 'High-risk destination approver', 'safety', choice(['Head of Operations', 'Chief Operating Officer', 'Head of Security'])),
    fact('insuranceCover', 'Travel insurance cover', 'safety', money(500000, 2000000, 100000)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'authorisation',
        title: 'Travel Authorisation',
        paragraphs: [
          `All business travel must be authorised before it is booked. Travel with a total estimated cost ` +
            `above ${f('financeApprovalThreshold')} additionally requires Finance approval, based on a ` +
            'written justification of the business need.',
          'Where a video meeting would achieve the same outcome, travel is not approved. The requesting ' +
            'manager records this consideration in the travel request.',
        ],
      },
      {
        key: 'booking',
        title: 'Booking',
        paragraphs: [
          `Travel must be booked at least ${f('advanceBooking')} before departure through the approved ` +
            'travel management provider. Bookings made outside the provider are reimbursed only where the ' +
            'provider could not supply the itinerary and the exception was approved in advance.',
        ],
      },
      {
        key: 'travel-class',
        title: 'Class of Travel',
        paragraphs: [
          `Economy class is the standard for all air travel. Business class may be booked where a single ` +
            `flight segment exceeds ${f('businessClassHours')} of scheduled flying time, or where a ` +
            'documented medical need applies.',
          'Rail travel is booked in standard class, with first class permitted only where it is cheaper ' +
            'than the standard fare at the time of booking.',
        ],
        table: {
          caption: 'Travel class entitlement',
          header: ['Journey', 'Standard entitlement', 'Approval for upgrade'],
          rows: [
            ['Air, under ' + f('businessClassHours'), 'Economy', 'Head of Department'],
            ['Air, over ' + f('businessClassHours'), 'Business', 'Not required'],
            ['Rail', 'Standard class', 'Not required if cheaper than standard'],
          ],
        },
      },
      {
        key: 'accommodation',
        title: 'Accommodation',
        paragraphs: [
          `Accommodation is booked at a maximum of ${f('hotelCap')} per night excluding tax, unless a ` +
            'higher rate is unavoidable because of an event or location constraint, in which case the ' +
            'traveller records the reason at booking.',
        ],
      },
      {
        key: 'safety',
        title: 'Traveller Safety',
        paragraphs: [
          `Travellers must be registered with the travel security service at least ` +
            `${f('safetyRegistration')} before departure so that they can be located in an emergency.`,
          `Travel to a destination classified as high risk requires the approval of the ` +
            `${f('highRiskApprover')} and a documented security briefing before departure.`,
          `Corporate travel insurance provides cover of up to ${f('insuranceCover')} per traveller for ` +
            'medical repatriation and personal liability.',
        ],
      },
      responsibilitiesSection([
        ['Traveller', 'Books within policy, registers with the security service and travels safely'],
        ['Approving Manager', 'Confirms business need and that travel is the only viable option'],
        ['Finance', 'Approves travel above the stated threshold and monitors travel spend'],
        ['Travel Management Provider', 'Supplies compliant itineraries and records booking exceptions'],
      ]),
      exceptionsSection('Head of Human Resources', 'the specific trip to which they relate'),
      relatedDocumentsSection(['Business Expense Policy', 'Expense Approval Procedure']),
    ];
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'When can an employee book business class travel?',
        sectionKey: 'travel-class',
        factIds: ['businessClassHours'],
        referenceAnswer: `Business class may be booked where a single flight segment exceeds ${f('businessClassHours')} of scheduled flying time, or for a documented medical need.`,
      },
      {
        type: 'DIRECT',
        question: 'What travel cost requires Finance approval?',
        sectionKey: 'authorisation',
        factIds: ['financeApprovalThreshold'],
        referenceAnswer: `Travel with a total estimated cost above ${f('financeApprovalThreshold')} requires Finance approval.`,
      },
      {
        type: 'DIRECT',
        question: 'What is the nightly accommodation limit for business travel?',
        sectionKey: 'accommodation',
        factIds: ['hotelCap'],
        referenceAnswer: `Accommodation is booked at a maximum of ${f('hotelCap')} per night excluding tax.`,
      },
    ];
  },
};

export const hrBlueprints: Blueprint[] = [annualLeavePolicy, remoteWorkPolicy, employeeTravelPolicy];
