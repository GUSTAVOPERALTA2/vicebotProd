// userManager.test.js (CommonJS compatible)
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');
const { test } = require('node:test');
const {
  getUser,
  registerUser,
  saveUsers,
  loadUsers
} = require('../config/userManager');

const usersFile = path.join(__dirname, '../data/users.json');
let backupUsers = null;

test('🧪 Backup de users.json', () => {
  const original = fs.readFileSync(usersFile, 'utf8');
  backupUsers = original;
  assert.ok(original);
});

test('✅ getUser retorna datos correctos para un usuario existente', () => {
  const user = getUser('5217751801318@c.us');
  assert.ok(user);
  assert.strictEqual(user.nombre, 'Gustavo Peralta');
});

test('✅ registerUser agrega correctamente y es recuperable por getUser', () => {
  const newId = 'test_user_123';
  const nombre = 'Test User';
  const cargo = 'QA';
  const rol = 'admin';

  const result = registerUser(newId, nombre, cargo, rol);
  assert.ok(result);

  const user = getUser(newId);
  assert.strictEqual(user.nombre, nombre);
  assert.strictEqual(user.cargo, cargo);
  assert.strictEqual(user.rol, rol);
});

test('🧹 Restaurar users.json original', () => {
  assert.ok(backupUsers);
  fs.writeFileSync(usersFile, backupUsers, 'utf8');
  const final = fs.readFileSync(usersFile, 'utf8');
  assert.strictEqual(final, backupUsers);
});















