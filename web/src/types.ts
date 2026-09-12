// Shared DTOs returned by the API. Keep these canonical so pages don't drift.

export interface Category {
  id: number;
  name: string;
  kind: 'income' | 'expense';
  parent_id: number | null;
  parent_name?: string | null;
  has_children?: boolean;
  sort_order: number;
  managed?: boolean;
  source_kind?: string | null;
  archived_at?: string | null;
}

// A transaction parsed from an import (CSV / future auto-load) awaiting review.
export interface StagedTxn {
  id: number;
  batch_id: number;
  account_id: number | null;
  category_id: number | null;
  txn_date: string | null;
  amount: number;
  direction: 'expense' | 'income' | 'transfer';
  merchant: string | null;
  raw_merchant: string | null;
  description: string | null;
  source: string | null;
  external_id: string | null;
  decision: 'import' | 'skip';
  duplicate_of: number | null;
  skip_reason: 'duplicate_in_file' | 'matches_existing' | null;
  account_name: string | null;
  category_name: string | null;
  dup_merchant: string | null;
  dup_date: string | null;
  dup_amount: number | null;
}

// Column mapping + preview returned by POST /imports/preview.
export interface ImportMapping { date: number; amount?: number; debit?: number; credit?: number; merchant?: number; description?: number }
export interface ImportPreview { headers: string[]; sampleRows: string[][]; rowCount: number; suggestedMapping: ImportMapping }
