-- getproperty-api 0057 — guides on the public site edited by the platform team (B7 deliverable 7.13, D-271): one row
-- per slug × locale with the shape of the shared article (`@collective/content` Article, D-277) — title, summary,
-- short answer, sections of blocks, FAQ, sources, reviewed / published dates, audience of the closing call to
-- action, the "general information, not advice" flag. Draft or published; publishing records who reviewed it (a
-- different platform user than the last editor). schema-design §7.5 row 141.

CREATE TYPE platform.guide_state AS ENUM ('draft', 'published');
CREATE TYPE platform.guide_category AS ENUM ('tax', 'law', 'landlord', 'operations');
CREATE TYPE platform.guide_audience AS ENUM ('landlord', 'apartment');

CREATE TABLE platform.guide (
  id              uuid NOT NULL DEFAULT uuidv7(),
  slug            text NOT NULL,
  locale          char(2) NOT NULL,
  category        platform.guide_category NOT NULL,
  audience        platform.guide_audience NOT NULL,
  title           text NOT NULL,
  summary         text NOT NULL,
  answer          text NOT NULL,
  sections        jsonb NOT NULL,
  faq             jsonb NOT NULL DEFAULT '[]',
  sources         jsonb NOT NULL DEFAULT '[]',
  read_minutes    smallint NOT NULL,
  general         boolean NOT NULL DEFAULT false,
  reviewed_on     date NOT NULL,
  published_on    date NOT NULL,
  state           platform.guide_state NOT NULL DEFAULT 'draft',
  reviewed_by     uuid,
  published_at    timestamptz(6),
  created_by      uuid,
  updated_by      uuid,
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  updated_at      timestamptz(6) NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT guide_pkey PRIMARY KEY (id),
  CONSTRAINT guide_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES core.user_account (id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT guide_slug_check CHECK (slug ~ '^[a-z0-9-]{1,80}$'),
  CONSTRAINT guide_locale_check CHECK (locale IN ('th', 'en')),
  CONSTRAINT guide_lengths_check CHECK (length(title) BETWEEN 1 AND 120 AND length(summary) BETWEEN 1 AND 200 AND length(answer) BETWEEN 1 AND 600),
  CONSTRAINT guide_read_minutes_check CHECK (read_minutes BETWEEN 1 AND 60),
  CONSTRAINT guide_dates_check CHECK (reviewed_on >= published_on),
  CONSTRAINT guide_published_check CHECK ((state = 'published') = (published_at IS NOT NULL)),
  CONSTRAINT guide_version_check CHECK (version >= 1)
);
COMMENT ON TABLE platform.guide IS 'D-271: public guides per slug and locale (the shared article shape, D-277); draft or published with who reviewed it.';
CREATE UNIQUE INDEX guide_slug_locale_key ON platform.guide (slug, locale);
CREATE INDEX guide_state_locale_idx ON platform.guide (state, locale, published_on DESC);
CREATE TRIGGER guide_set_updated_at BEFORE UPDATE ON platform.guide FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

SELECT platform.apply_rls('platform.guide', 'platform');
GRANT SELECT, INSERT, UPDATE ON platform.guide TO gp_platform;
GRANT SELECT ON platform.guide TO gp_reporting;
