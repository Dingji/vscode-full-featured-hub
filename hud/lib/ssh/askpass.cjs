// The askpass program ssh will exec: print the password and exit BEFORE node tries to run
// the "script" ssh passes as an argument. Loaded through NODE_OPTIONS=--require.
const password = process.env.DSH_SSH_PASSWORD ?? ''
if (password !== '') process.stdout.write(`${password}\n`)
process.exit(0)