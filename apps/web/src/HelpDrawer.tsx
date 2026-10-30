import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import {
  helpGuides,
  helpTopics,
  searchHelp,
  type HelpGuideId,
} from './help/guides.js';
import { GuideContent } from './help/GuideContent.js';
export function HelpDrawer({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null),
    search = useRef<HTMLInputElement>(null),
    article = useRef<HTMLElement>(null);
  const [query, setQuery] = useState(''),
    [category, setCategory] = useState('All topics'),
    [selected, setSelected] = useState('connecting'),
    [anchor, setAnchor] = useState('');
  const topic =
      helpTopics.find((item) => item.id === selected) ?? helpTopics[0]!,
    guide = helpGuides.find((item) => item.id === topic.guideId)!,
    results = searchHelp(query, category);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    search.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (!anchor) return;
    dialog.current
      ?.querySelector(`[id="guide-${topic.guideId}-${CSS.escape(anchor)}"]`)
      ?.scrollIntoView({ block: 'start' });
  }, [anchor, topic]);
  function navigate(id: HelpGuideId, nextAnchor = '') {
    setSelected(id);
    setAnchor(nextAnchor);
    setQuery('');
    setCategory('All topics');
    article.current?.focus();
  }
  return (
    <dialog
      ref={dialog}
      className="help-drawer"
      aria-labelledby="help-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="dialog-header">
        <div>
          <span className="eyebrow">LOCAL GUIDES · NO PROVIDER REQUESTS</span>
          <h2 id="help-title">Help & Guides</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close Help & Guides"
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="help-controls">
        <div className="form-fields">
          <label htmlFor="help-search">Search help topics</label>
          <input
            ref={search}
            id="help-search"
            type="search"
            maxLength={200}
            placeholder="Try Cursor, OAuth or exit code -1"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="form-fields">
          <label htmlFor="help-category">Category</label>
          <select
            id="help-category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option>All topics</option>
            {helpGuides.map((guide) => (
              <option key={guide.id}>{guide.category}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="help-layout">
        <nav aria-label="Help topics">
          <p className="muted" role="status">
            {results.length} topics
          </p>
          {results.length ? (
            <ul>
              {results.map((item) => (
                <li key={item.id}>
                  <button
                    className={selected === item.id ? 'selected' : ''}
                    aria-current={selected === item.id ? 'page' : undefined}
                    onClick={() => {
                      setSelected(item.id);
                      setAnchor('');
                      article.current?.focus();
                    }}
                  >
                    <small>{item.category}</small>
                    <span>{item.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>No matching topics. Try a shorter search or another category.</p>
          )}
        </nav>
        <article
          ref={article}
          tabIndex={-1}
          aria-label="Guide content"
          className="guide-content"
        >
          <div className="guide-source">
            <span>docs/guides/{guide.file}</span>
            <button className="guide-link" onClick={() => navigate(guide.id)}>
              Read full {guide.file}
            </button>
          </div>
          <GuideContent
            content={topic.content}
            guideId={topic.guideId}
            navigate={navigate}
          />
        </article>
      </div>
    </dialog>
  );
}
