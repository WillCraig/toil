/**
 * "Scopes toil needs" (#561): what a token must be allowed to do, from the
 * area's own declaration (`toil connections scopes`), shown beside the token
 * box as a closed disclosure so a newcomer sees a quiet screen and a person
 * who is about to make a token sees exactly what to tick. The links are plain
 * anchors the person follows to the vendor's page; Toil UI never calls them,
 * and nothing about the token goes into them but the scope names.
 */

import type { DescribedScopes } from '../../../../src/core/scopes.ts';
import { Copy } from '../../components/layout.tsx';
import { ChoiceRadios } from './parts.tsx';

type Kind = DescribedScopes['kinds'][number];

/** The radio that says which kind of token the person holds. It only changes the help beneath it: toil tells them apart by the token itself. */
export function TokenKindRadios({ scopes, kindId, onKind }: { scopes: DescribedScopes; kindId: string; onKind: (id: string) => void }) {
  return (
    <ChoiceRadios
      label="Token type"
      field="tokenKind"
      selected={kindId}
      onChange={onKind}
      options={scopes.kinds.map((k) => ({ key: k.id, label: `${k.label}${k.tokenPrefix ? ` (${k.tokenPrefix}…)` : ''}`, note: k.summary }))}
      hint="Not sent anywhere and not saved: it only changes the help below. toil works out which kind a token is from the token itself."
    />
  );
}

function NeedsList({ title, needs, createUrl, link }: { title: string; needs: string[]; createUrl: string; link: string }) {
  return (
    <div className="scopes__use">
      <h4>{title}</h4>
      <ul className="plain scopes__list">
        {needs.map((n) => (
          <li key={n}>
            <code>{n}</code>
          </li>
        ))}
      </ul>
      <p className="scopes__actions">
        <Copy value={needs.join(', ')} what={`the scopes for ${title.toLowerCase()}`} />{' '}
        <a href={createUrl} target="_blank" rel="noopener noreferrer">
          {link}
        </a>
      </p>
    </div>
  );
}

export function ScopesDisclosure({ scopes, kindId }: { scopes: DescribedScopes; kindId: string }) {
  const kind: Kind | undefined = scopes.kinds.find((k) => k.id === kindId) ?? scopes.kinds[0];
  if (!kind) return null;
  return (
    <details className="more scopes" data-scopes="">
      <summary>Scopes toil needs</summary>
      <p className="note">
        For a {kind.label.toLowerCase()}. The page opens in a new tab; Toil UI never calls it.
      </p>
      <NeedsList title="Read-only use needs" needs={kind.readOnly.needs} createUrl={kind.readOnly.createUrl} link="Create a token for read-only use" />
      <NeedsList title="Everything toil can do needs" needs={kind.everything.needs} createUrl={kind.everything.createUrl} link="Create a token for everything" />
      <details className="more">
        <summary>Which commands need what</summary>
        <ul className="plain scopes__entries">
          {kind.entries.map((e) => (
            <li key={`${e.name}-${e.access ?? ''}`}>
              <strong>
                {e.name}
                {e.access ? `: ${e.access === 'write' ? 'Read and write' : 'Read'}` : ''}
              </strong>{' '}
              <span className="note">{e.required === 'read' ? 'read-only use' : 'writes only'}</span>
              <span className="note scopes__commands">{e.commands.join(', ')}</span>
              {e.note && <span className="note">{e.note}</span>}
            </li>
          ))}
        </ul>
      </details>
    </details>
  );
}
