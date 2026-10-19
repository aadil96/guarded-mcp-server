import { mintToken, type Scope } from '../src/auth/tokens.js';

// usage: pnpm mint-token <actor> <scope[,scope]>   (scopes: read, refund:request)
// Prints the raw token once (give it to the client) and the hash line (put it in the token config).
const [actor, scopes] = process.argv.slice(2);
if (!actor || !scopes) {
  console.error('usage: pnpm mint-token <actor> <read|refund:request>[,...]');
  process.exit(2);
}
try {
  const { token, line } = mintToken(actor, scopes.split(',') as Scope[]);
  console.log(`token (shown once, store it in the client only): ${token}`);
  console.log(`config line (MCP_HTTP_TOKENS_FILE): ${line}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
