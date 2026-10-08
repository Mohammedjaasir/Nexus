'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  INITIAL_DOMAINS,
  listDomainDefinitions,
  getDomainDefinition,
  listDomainRoles,
  getDomainRole,
  getRolesForDomain
} = loadTs('src/shared/domain.ts');

test('HQ Domain Registry: All 12 initial domains exist with complete metadata', () => {
  const domains = listDomainDefinitions();
  assert.ok(domains.length >= 12, `Expected at least 12 domains, got ${domains.length}`);

  const requiredDomainIds = [
    'software-engineering',
    'ai-ml',
    'cybersecurity',
    'computer-vision',
    'data-science',
    'data-analytics',
    'devops-cloud',
    'web-app-dev',
    'mobile-dev',
    'robotics-iot',
    'game-dev',
    'research-scientific'
  ];

  for (const id of requiredDomainIds) {
    const dom = getDomainDefinition(id);
    assert.ok(dom, `Domain ${id} must exist`);
    assert.equal(dom.id, id);
    assert.ok(dom.name, `Domain ${id} must have a name`);
    assert.ok(!('departmentName' in dom), `Domain ${id} must not carry a departmentName`);
    assert.ok(!('departmentRoom' in dom), `Domain ${id} must not carry a departmentRoom`);
    assert.ok(dom.badgeColor, `Domain ${id} must have a badgeColor`);
    assert.ok(!('leadCharacter' in dom), `Domain ${id} must not carry a leadCharacter`);
    assert.ok(dom.agentRoles.length > 0, `Domain ${id} must have specialist roles`);
  }
});

test('HQ Specialist Roles: roles carry no persona field', () => {
  for (const [domId, dom] of Object.entries(INITIAL_DOMAINS)) {
    for (const role of dom.agentRoles) {
      assert.ok(!('character' in role), `Role ${role.roleId} must not carry a character`);
      assert.ok(role.title, `Role ${role.roleId} must have a title`);
      assert.ok(role.capabilities.length > 0, `Role ${role.roleId} must have capabilities`);
      assert.ok(role.verificationRules.length > 0, `Role ${role.roleId} must have verification rules`);
      assert.ok(role.contextStrategy.defaultBudgetTokens > 0, `Role ${role.roleId} must have a budget`);
    }
  }
});
