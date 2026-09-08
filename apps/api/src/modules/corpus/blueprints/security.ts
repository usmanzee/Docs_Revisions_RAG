/** Information Security blueprints: credentials and data classification. */

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
  relatedDocumentsSection,
  responsibilitiesSection,
  years,
  type Blueprint,
} from './shared.js';

export const passwordSecurityPolicy: Blueprint = {
  key: 'password-security-policy',
  codePrefix: 'SEC-POL',
  title: 'Password Security Policy',
  department: 'Information Security',
  documentType: 'POLICY',
  category: 'Access Control',
  ownerRole: 'Chief Information Security Officer',
  tags: ['password', 'authentication', 'mfa', 'access control'],
  description:
    'Defines password composition, rotation, multi-factor authentication and privileged credential handling ' +
    'for all corporate and production systems.',
  purpose:
    'This policy defines the minimum standards for authentication credentials used to access corporate ' +
    'systems, so that account compromise does not become system compromise.',
  scope:
    'This policy applies to every account that can authenticate to a corporate system, including service ' +
    'accounts, privileged accounts and accounts held by third parties.',

  facts: [
    fact('minLength', 'Minimum password length', 'password-standards', count(12, 16, 'characters')),
    fact('privilegedLength', 'Privileged account minimum length', 'privileged-access', count(16, 24, 'characters')),
    fact('historyCount', 'Password history retained', 'password-standards', count(6, 24, 'previous passwords')),
    fact('rotationPeriod', 'Standard rotation period', 'password-standards', days(90, 365)),
    fact('privilegedRotation', 'Privileged rotation period', 'privileged-access', days(30, 90)),
    fact('lockoutAttempts', 'Failed attempts before lockout', 'account-lockout', count(3, 10, 'failed attempts')),
    fact('lockoutDuration', 'Lockout duration', 'account-lockout', minutes(15, 60, 5)),
    fact('mfaRequirement', 'Multi-factor requirement', 'multi-factor', choice(['all remote access and all administrative access'])),
    fact('sessionTimeout', 'Privileged session timeout', 'privileged-access', minutes(10, 30, 5)),
    fact('vaultCheckout', 'Maximum credential checkout', 'privileged-access', hours(4, 12)),
    fact('serviceAccountReview', 'Service account review interval', 'service-accounts', months(3, 12)),
    fact('breachResponse', 'Credential compromise response time', 'incident-response', hours(1, 4)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'password-standards',
        title: 'Password Standards',
        paragraphs: [
          `Passwords for standard user accounts must be at least ${f('minLength')} long and must not appear ` +
            'in the published breached-password corpus checked at the point the password is set.',
          `The system retains the last ${f('historyCount')} and prevents their reuse. Standard account ` +
            `passwords are rotated every ${f('rotationPeriod')}, and immediately on any suspicion of ` +
            'compromise.',
          'Complexity rules that force a specific mix of character classes are not applied, because they ' +
            'produce predictable substitutions. Length and breach checking are relied on instead.',
        ],
        bullets: [
          'Passwords must not be shared between individuals under any circumstances.',
          'Passwords must not be written down or stored in an unencrypted file.',
          'A password used for a corporate system must not be reused on any external service.',
        ],
      },
      {
        key: 'multi-factor',
        title: 'Multi-Factor Authentication',
        paragraphs: [
          `Multi-factor authentication is mandatory for ${f('mfaRequirement')}. SMS is not accepted as a ` +
            'second factor; an authenticator application or a hardware security key must be used.',
          'Where a system cannot support multi-factor authentication, access is restricted to the corporate ' +
            'network and the limitation is recorded on the risk register.',
        ],
      },
      {
        key: 'account-lockout',
        title: 'Account Lockout',
        paragraphs: [
          `An account is locked after ${f('lockoutAttempts')} within a fifteen-minute window, and remains ` +
            `locked for ${f('lockoutDuration')} or until it is released by the service desk after identity ` +
            'verification.',
        ],
      },
      {
        key: 'privileged-access',
        title: 'Privileged Access',
        paragraphs: [
          `Privileged and administrative account passwords must be at least ${f('privilegedLength')} long ` +
            `and are rotated every ${f('privilegedRotation')}. They are held in the privileged access ` +
            'vault and are never stored in scripts, configuration files or source control.',
          `Credentials checked out of the vault are valid for a maximum of ${f('vaultCheckout')}, after ` +
            `which they are rotated automatically. Privileged sessions time out after ` +
            `${f('sessionTimeout')} of inactivity.`,
        ],
      },
      {
        key: 'service-accounts',
        title: 'Service Accounts',
        paragraphs: [
          `Every service account has a named human owner and is reviewed every ` +
            `${f('serviceAccountReview')}. Accounts without an identified owner are disabled at review.`,
          'Service account credentials are injected at runtime from the secrets store. Embedding a ' +
            'credential in an application artefact is a reportable security incident.',
        ],
      },
      {
        key: 'incident-response',
        title: 'Compromised Credentials',
        paragraphs: [
          `A credential believed to be compromised must be reported to the service desk immediately and is ` +
            `disabled or rotated within ${f('breachResponse')} of the report.`,
          'Reporting a suspected compromise in good faith never attracts disciplinary action, including ' +
            'where the cause was the reporter’s own mistake.',
        ],
      },
      definitionsSection([
        ['Privileged account', 'an account that can change system configuration or access other users’ data'],
        ['Service account', 'a non-human account used by an application or automated process'],
        ['Second factor', 'an authentication element independent of the password, such as a hardware key'],
      ]),
      responsibilitiesSection([
        ['All Users', 'Protects their credentials and reports suspected compromise immediately'],
        ['System Owner', 'Ensures their system enforces these standards or records an approved exception'],
        ['Information Security', 'Owns this policy, operates the vault and monitors for credential exposure'],
        ['Service Desk', 'Verifies identity before releasing a locked account or resetting a password'],
      ]),
      exceptionsSection('Chief Information Security Officer', 'twelve months'),
      complianceSection('annually', 'Chief Information Security Officer'),
      relatedDocumentsSection([
        'Information Classification Policy',
        'Remote Work Policy',
        'Production Incident Management Procedure',
      ]),
    ];
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'What is the minimum password length for standard user accounts?',
        sectionKey: 'password-standards',
        factIds: ['minLength'],
        referenceAnswer: `Passwords for standard user accounts must be at least ${f('minLength')} long.`,
      },
      {
        type: 'DIRECT',
        question: 'How often must privileged account passwords be rotated?',
        sectionKey: 'privileged-access',
        factIds: ['privilegedRotation'],
        referenceAnswer: `Privileged and administrative account passwords are rotated every ${f('privilegedRotation')}.`,
      },
      {
        type: 'DIRECT',
        question: 'How many failed login attempts trigger an account lockout?',
        sectionKey: 'account-lockout',
        factIds: ['lockoutAttempts', 'lockoutDuration'],
        referenceAnswer: `An account is locked after ${f('lockoutAttempts')} and remains locked for ${f('lockoutDuration')}.`,
      },
      {
        type: 'PARAPHRASE',
        question: 'Is a text message acceptable as a second authentication factor?',
        sectionKey: 'multi-factor',
        factIds: [],
        referenceAnswer:
          'No. SMS is not accepted as a second factor; an authenticator application or hardware security key must be used.',
      },
      {
        type: 'CROSS_SECTION',
        question: 'How are service account credentials stored and how often are they reviewed?',
        sectionKey: 'service-accounts',
        factIds: ['serviceAccountReview'],
        referenceAnswer: `Service account credentials are injected at runtime from the secrets store and each account is reviewed every ${f('serviceAccountReview')}.`,
      },
    ];
  },
};

export const informationClassificationPolicy: Blueprint = {
  key: 'information-classification-policy',
  codePrefix: 'SEC-POL',
  title: 'Information Classification Policy',
  department: 'Information Security',
  documentType: 'POLICY',
  category: 'Data Governance',
  ownerRole: 'Chief Information Security Officer',
  tags: ['classification', 'data', 'handling', 'retention'],
  description:
    'Defines the four information classification levels, the handling rules for each, and the retention ' +
    'periods that apply.',
  purpose:
    'This policy establishes a consistent way to classify information by sensitivity, so that handling and ' +
    'retention decisions follow from the classification rather than from individual judgement.',
  scope:
    'This policy applies to information in any form - electronic, printed or spoken - created, received or ' +
    'processed on behalf of the organisation.',

  facts: [
    fact('levelCount', 'Number of classification levels', 'classification-levels', choice(['four'])),
    fact('restrictedRetention', 'Restricted information retention', 'retention', years(5, 10)),
    fact('internalRetention', 'Internal information retention', 'retention', years(2, 7)),
    fact('reclassifyReview', 'Classification review interval', 'review', months(12, 36)),
    fact('encryptionStandard', 'Encryption standard at rest', 'handling', choice(['AES-256'])),
    fact('breachNotification', 'Breach notification deadline', 'breach', hours(24, 72)),
    fact('disposalCertificate', 'Secure disposal certificate window', 'disposal', businessDays(5, 20)),
  ],

  build(context) {
    const { f } = context;
    return [
      {
        key: 'classification-levels',
        title: 'Classification Levels',
        paragraphs: [
          `Information is classified into ${f('levelCount')} levels. Every document, dataset and system ` +
            'record carries exactly one classification, assigned by its owner at the point of creation.',
          'Where a collection contains items of differing sensitivity, the collection takes the ' +
            'classification of its most sensitive item.',
        ],
        table: {
          caption: 'Classification levels and handling',
          header: ['Level', 'Description', 'Sharing', 'Storage'],
          rows: [
            ['Public', 'Approved for release outside the organisation', 'Unrestricted', 'Any approved system'],
            ['Internal', 'Routine business information', 'Employees and contractors', 'Corporate systems only'],
            [
              'Confidential',
              'Commercially sensitive or personal data',
              'Named recipients with business need',
              'Encrypted corporate systems',
            ],
            [
              'Restricted',
              'Severe impact if disclosed',
              'Named recipients, approved by the information owner',
              'Encrypted, access logged',
            ],
          ],
        },
      },
      {
        key: 'handling',
        title: 'Handling Requirements',
        paragraphs: [
          `Confidential and Restricted information must be encrypted at rest using ` +
            `${f('encryptionStandard')} or an approved equivalent, and encrypted in transit using current ` +
            'transport security.',
          'Restricted information must not be transmitted through personal email, consumer messaging ' +
            'applications or unmanaged file-sharing services.',
        ],
        bullets: [
          'Label every document with its classification in the header or footer.',
          'Verify the recipient list before sending Confidential or Restricted material.',
          'Do not discuss Restricted information in a public place or on an unsecured call.',
        ],
      },
      {
        key: 'retention',
        title: 'Retention',
        paragraphs: [
          `Restricted information is retained for ${f('restrictedRetention')} unless a longer statutory or ` +
            `contractual period applies. Internal information is retained for ${f('internalRetention')}.`,
          'Retention periods start from the end of the calendar year in which the information was last ' +
            'used for a business purpose.',
        ],
      },
      {
        key: 'review',
        title: 'Reclassification and Review',
        paragraphs: [
          `Information owners review classifications every ${f('reclassifyReview')}. Information whose ` +
            'sensitivity has fallen may be downgraded only by its owner, and the change is recorded.',
        ],
      },
      {
        key: 'disposal',
        title: 'Secure Disposal',
        paragraphs: [
          `Physical media holding Confidential or Restricted information is destroyed by an approved ` +
            `supplier, and a certificate of destruction is obtained within ${f('disposalCertificate')}.`,
        ],
      },
      {
        key: 'breach',
        title: 'Breach Reporting',
        paragraphs: [
          `A suspected disclosure of Confidential or Restricted information must be reported to ` +
            `Information Security immediately, and the regulator notification assessment is completed ` +
            `within ${f('breachNotification')} of the organisation becoming aware.`,
        ],
      },
      responsibilitiesSection([
        ['Information Owner', 'Assigns and reviews classification and approves Restricted sharing'],
        ['All Users', 'Handles information according to its classification and reports suspected breaches'],
        ['Information Security', 'Maintains the classification scheme and assesses reported breaches'],
        ['Legal and Compliance', 'Determines statutory retention and regulator notification obligations'],
      ]),
      exceptionsSection('Chief Information Security Officer', 'twelve months'),
      relatedDocumentsSection(['Password Security Policy', 'Data Retention Standard']),
    ];
  },

  questions(context) {
    const { f } = context;
    return [
      {
        type: 'DIRECT',
        question: 'How long is Restricted information retained?',
        sectionKey: 'retention',
        factIds: ['restrictedRetention'],
        referenceAnswer: `Restricted information is retained for ${f('restrictedRetention')} unless a longer statutory or contractual period applies.`,
      },
      {
        type: 'TERMINOLOGY',
        question: 'What encryption standard is required for confidential data at rest?',
        sectionKey: 'handling',
        factIds: ['encryptionStandard'],
        referenceAnswer: `Confidential and Restricted information must be encrypted at rest using ${f('encryptionStandard')} or an approved equivalent.`,
      },
      {
        type: 'DIRECT',
        question: 'How quickly must a suspected data breach notification assessment be completed?',
        sectionKey: 'breach',
        factIds: ['breachNotification'],
        referenceAnswer: `The regulator notification assessment is completed within ${f('breachNotification')} of the organisation becoming aware.`,
      },
    ];
  },
};

export const securityBlueprints: Blueprint[] = [passwordSecurityPolicy, informationClassificationPolicy];
