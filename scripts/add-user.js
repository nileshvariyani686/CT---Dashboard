'use strict';
/**
 * User management CLI for CT Dashboard.
 *
 * Usage:
 *   node scripts/add-user.js                  → interactive: add a new user
 *   node scripts/add-user.js --list           → list all users
 *   node scripts/add-user.js --delete <user>  → remove a user
 *   node scripts/add-user.js --password <user>→ change a user's password
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const rl     = require('readline');

const USERS_PATH   = path.join(__dirname, '..', 'data', 'users.json');
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, dkLen: 64 };

// ---- helpers ----
function loadUsers() {
  if (!fs.existsSync(USERS_PATH)) return { users: [] };
  return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
}
function saveUsers(store) {
  fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true });
  fs.writeFileSync(USERS_PATH, JSON.stringify(store, null, 2));
}
function hashPassword(password, salt) {
  return crypto.scryptSync(
    password,
    Buffer.from(salt, 'hex'),
    SCRYPT_PARAMS.dkLen,
    { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p }
  ).toString('hex');
}

// ---- prompts ----
const prompt = rl.createInterface({ input: process.stdin, output: process.stdout });
const ask    = (q) => new Promise(resolve => prompt.question(q, resolve));
const askHidden = (q) => new Promise(resolve => {
  process.stdout.write(q);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let input = '';
  process.stdin.on('data', function handler(ch) {
    const c = ch.toString();
    if (c === '\n' || c === '\r' || c === '\u0003') {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', handler);
      process.stdout.write('\n');
      resolve(input);
    } else if (c === '\u007f' || c === '\b') {
      if (input.length > 0) { input = input.slice(0, -1); process.stdout.write('\b \b'); }
    } else {
      input += c;
      process.stdout.write('*');
    }
  });
});

// ---- commands ----
function listUsers() {
  const store = loadUsers();
  if (store.users.length === 0) {
    console.log('No users found.');
    return;
  }
  console.log('\nUsers:');
  store.users.forEach(u => console.log(`  [${u.id}] ${u.username.padEnd(20)} ${u.name}`));
  console.log('');
}

async function addUser() {
  const store    = loadUsers();
  const username = (await ask('Username      : ')).trim().toLowerCase();
  if (!username) { console.error('Username cannot be empty.'); process.exit(1); }
  if (store.users.find(u => u.username === username)) {
    console.error(`User "${username}" already exists. Use --password to change their password.`);
    process.exit(1);
  }
  const name     = (await ask('Display name  : ')).trim() || username;
  const password = await askHidden('Password      : ');
  const confirm  = await askHidden('Confirm       : ');
  if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1); }
  if (password.length < 8)  { console.error('Password must be at least 8 characters.'); process.exit(1); }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const id   = (store.users.reduce((m, u) => Math.max(m, u.id), 0)) + 1;

  store.users.push({ id, username, name, salt, hash });
  saveUsers(store);
  console.log(`\n✓ User "${username}" (${name}) added.\n`);
}

async function deleteUser(target) {
  const store = loadUsers();
  const idx   = store.users.findIndex(u => u.username === target);
  if (idx === -1) { console.error(`User "${target}" not found.`); process.exit(1); }
  const confirm = (await ask(`Delete user "${target}"? Type YES to confirm: `)).trim();
  if (confirm !== 'YES') { console.log('Aborted.'); process.exit(0); }
  store.users.splice(idx, 1);
  saveUsers(store);
  console.log(`✓ User "${target}" deleted.\n`);
}

async function changePassword(target) {
  const store = loadUsers();
  const user  = store.users.find(u => u.username === target);
  if (!user) { console.error(`User "${target}" not found.`); process.exit(1); }
  const password = await askHidden(`New password for "${target}": `);
  const confirm  = await askHidden('Confirm             : ');
  if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1); }
  if (password.length < 8)  { console.error('Password must be at least 8 characters.'); process.exit(1); }

  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = hashPassword(password, user.salt);
  saveUsers(store);
  console.log(`\n✓ Password updated for "${target}".\n`);
}

// ---- entry ----
(async () => {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    listUsers();
    process.exit(0);
  } else if (args.includes('--delete')) {
    const target = args[args.indexOf('--delete') + 1];
    if (!target) { console.error('Specify a username: --delete <username>'); process.exit(1); }
    await deleteUser(target);
  } else if (args.includes('--password')) {
    const target = args[args.indexOf('--password') + 1];
    if (!target) { console.error('Specify a username: --password <username>'); process.exit(1); }
    await changePassword(target);
  } else {
    await addUser();
  }

  prompt.close();
  process.exit(0);
})();
