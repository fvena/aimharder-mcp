// Child-process HTTP seam: every fetch is intercepted; unexpected requests fail closed.
import assert from 'node:assert/strict';
const account = { id: 42, roles: [{ id: 100, boid: 200, role: 'client', gym: 'Sample gym', centre_url: 'sample-gym.aimharder.es' }] };
globalThis.fetch = async (url, options = {}) => {
  if (String(url) === 'https://login.aimharder.es/api/login') {
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.username, 'account@example.invalid');
    assert.equal(body.password, 'synthetic-password');
    if (process.env.PACKAGE_FIXTURE_DENY === '1') return Response.json({ error: 'synthetic-password private upstream content' }, { status: 403 });
    return Response.json({ data: { userData: account, auth: { authOK: true } } }, { headers: { 'Set-Cookie': 'amhrdrauth=synthetic-cookie; Domain=.aimharder.es; Path=/; HttpOnly' } });
  }
  if (String(url) === 'https://aimharder.es/api/whoami') {
    assert.equal(options.method, 'GET');
    assert.match(new Headers(options.headers).get('cookie'), /amhrdrauth=synthetic-cookie/);
    return Response.json({ data: [account] });
  }
  throw new Error('Unexpected fixture request');
};
