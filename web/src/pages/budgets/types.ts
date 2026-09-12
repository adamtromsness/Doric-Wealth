export interface Account { id: number; name: string }

export interface Budget { id: number; name: string; period: string; start_date: string }
export type RolloverMode = 'reset' | 'carryover' | 'accrue';
export const ROLLOVER_MODES: [RolloverMode, string][] = [['reset', 'Reset'], ['carryover', 'Carry Over'], ['accrue', 'Accrue']];
export const ROLLOVER_DESC: Record<RolloverMode, string> = {
  reset: 'Resets to the planned amount each period — unspent funds are not carried over.',
  carryover: 'Unspent funds roll into the next period. Overspending is forgiven (the balance never goes negative).',
  accrue: 'Builds a running balance (a sinking fund). Overspending draws the balance down.',
};

export interface Line {
  line_id: number; category_id: number; category_name: string; allocated: number; actual: number;
  base_amount?: number; rollover_mode?: RolloverMode; carry_in?: number; opening_balance?: number;
}
export interface Txn {
  txn_id: number; split_id: number | null; txn_date: string; amount: number;
  category_id: number | null; category_name: string | null; account_name: string | null;
  merchant: string | null; description: string | null;
}

export interface Group { group_id: number; group_name: string; allocated: number; actual: number; lines: Line[] }
export interface Section {
  kind: 'expense' | 'income';
  groups: Group[];
  uncategorized: number;
  allocated: number;
  actual: number;
  total_actual: number;
}
export interface DayFlow { date: string; income: number; expense: number; net: number }
export interface Progress {
  period: string;
  window: { start: string; end: string; label: string };
  account_ids: number[];
  bucket: 'day' | 'week';
  daily: DayFlow[];
  sections: Section[];
}
