-- Transfer Ledger schema (MySQL 8 / MariaDB 10.6+, InnoDB)
-- All money is stored as signed integer paise (BIGINT). Never floats.

CREATE TABLE IF NOT EXISTS accounts (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(100) NOT NULL,
  currency       CHAR(3)      NOT NULL DEFAULT 'INR',
  -- Cached balance, always updated in the same transaction as the postings.
  -- The reconciliation job proves it equals SUM(postings.amount).
  balance        BIGINT       NOT NULL DEFAULT 0,
  -- Only the system funding account may go negative (it represents money
  -- entering the ledger from outside), so all balances always sum to zero.
  allow_negative BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

-- One row per business event. Append-only: mistakes are fixed with a
-- reversal entry, never by UPDATE or DELETE.
CREATE TABLE IF NOT EXISTS journal_entries (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  kind              ENUM('deposit','transfer','reversal') NOT NULL,
  description       VARCHAR(255) NULL,
  reverses_entry_id BIGINT NULL,
  created_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- An entry can be reversed at most once.
  UNIQUE KEY uq_reverses (reverses_entry_id),
  CONSTRAINT fk_reverses FOREIGN KEY (reverses_entry_id) REFERENCES journal_entries(id)
) ENGINE=InnoDB;

-- Double-entry lines. The postings of every entry sum to zero.
CREATE TABLE IF NOT EXISTS postings (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  entry_id   BIGINT NOT NULL,
  account_id BIGINT NOT NULL,
  amount     BIGINT NOT NULL,          -- negative = debit, positive = credit
  KEY idx_postings_account (account_id, id),
  KEY idx_postings_entry (entry_id),
  CONSTRAINT fk_post_entry   FOREIGN KEY (entry_id)   REFERENCES journal_entries(id),
  CONSTRAINT fk_post_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB;

-- Stripe-style idempotency: the first response for a key is stored and
-- replayed for every retry with the same key and the same request body.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  idem_key      VARCHAR(255) NOT NULL PRIMARY KEY,
  request_hash  CHAR(64)     NOT NULL,
  response_code INT          NOT NULL,
  response_body TEXT         NOT NULL,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

-- Transactional outbox: events are written in the same DB transaction as
-- the money movement, then published (at-least-once) by a worker.
CREATE TABLE IF NOT EXISTS outbox (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_type   VARCHAR(50)  NOT NULL,
  payload      TEXT         NOT NULL,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at TIMESTAMP(3) NULL,
  KEY idx_outbox_unpublished (published_at, id)
) ENGINE=InnoDB;
