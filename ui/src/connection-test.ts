/**
 * What a connection test found, as one sentence a person can read: whether it
 * answered, whether the login works (on the deeper reads a real command would
 * make too), and when the login expires, where the service said. A credential the
 * service didn't say anything about gets no claim about its expiry.
 */

export interface ConnectionTestData {
  live: boolean;
  authenticated: boolean;
  request: string | null;
  /** Every read made, the first one included; absent from an older toil. */
  checked?: string[];
  /** The day the service says the credential expires, or null when it didn't say. */
  expires?: string | null;
  scopes?: string[] | null;
}

/** `subject` is what answered: a connection's name, or a tool's. The reads it made are not named: they are requests, and a request path is not for the people reading this. */
export function testSentence(d: ConnectionTestData, subject: string): string {
  const deeper = (d.checked?.length ?? 0) > 1;
  const works = d.authenticated ? `, so its login works${deeper ? ' for the deeper checks too' : ''}` : ', but that check needs no login, so it shows only that the address responds';
  const expiry = d.authenticated && d.expires ? `, and the login expires ${d.expires}` : '';
  const scopes = d.authenticated && d.scopes && d.scopes.length > 0 ? ` Its permissions: ${d.scopes.join(', ')}.` : '';
  return `${subject} answered${works}${expiry}.${scopes}`;
}
