import { pool, query, one } from './db.js';

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function seed() {
  console.log('Clearing existing data...');
  await query(`TRUNCATE accounts, account_balances, categories, budgets, budget_lines,
               vehicles, assets, liabilities, subscriptions, goals, transactions, receipts,
               receipt_items, utility_bills, utility_accounts, utility_invoices,
               utility_invoice_lines, ai_analyses
               RESTART IDENTITY CASCADE`);

  // Every tenant-owned row must carry a book_id (NOT NULL + row-level
  // security). Reuse the oldest book — so a login created by `npm run
  // bootstrap` (which also adopts the oldest book) sees this demo data —
  // or create one when seeding a brand-new database.
  let hhRow = await one<{ id: number }>(`SELECT id FROM books ORDER BY id LIMIT 1`);
  if (!hhRow) {
    hhRow = await one<{ id: number }>(`INSERT INTO books (name) VALUES ('Demo Book') RETURNING id`);
    console.log(`Created book #${hhRow!.id} "Demo Book".`);
  }
  const HH = hhRow!.id;
  console.log(`Seeding demo data into book #${HH}.`);

  console.log('Seeding accounts...');
  const checking = await one<any>(`INSERT INTO accounts (name,type,institution,book_id) VALUES ('Everyday Checking','checking','First National',$1) RETURNING id`, [HH]);
  const savings = await one<any>(`INSERT INTO accounts (name,type,institution,book_id) VALUES ('Emergency Savings','savings','First National',$1) RETURNING id`, [HH]);
  const invest = await one<any>(`INSERT INTO accounts (name,type,institution,book_id) VALUES ('Brokerage','investment','Vanguard',$1) RETURNING id`, [HH]);
  const card = await one<any>(`INSERT INTO accounts (name,type,institution,is_liability,book_id) VALUES ('Rewards Card','credit_card','Chase',TRUE,$1) RETURNING id`, [HH]);
  const hsa = await one<any>(`INSERT INTO accounts (name,type,institution,book_id) VALUES ('Health Savings','hsa','HealthEquity',$1) RETURNING id`, [HH]);

  console.log('Seeding categories (groups + items)...');
  // High-level group -> its budget items. Items inherit the group's kind.
  const tree: { group: string; kind: string; items: string[] }[] = [
    { group: 'Income', kind: 'income', items: ['Salary'] },
    { group: 'Food & Dining', kind: 'expense', items: ['Groceries', 'Dining'] },
    { group: 'Auto', kind: 'expense', items: ['Fuel', 'Auto Maintenance', 'Auto Insurance'] },
    { group: 'Home', kind: 'expense', items: ['Utilities', 'Rent/Mortgage'] },
    { group: 'Lifestyle', kind: 'expense', items: ['Entertainment', 'Health', 'Shopping'] },
  ];
  const cats: Record<string, number> = {};
  for (const { group, kind, items } of tree) {
    const g = await one<any>(`INSERT INTO categories (name,kind,book_id) VALUES ($1,$2,$3) RETURNING id`, [group, kind, HH]);
    cats[group] = g.id;
    for (const item of items) {
      const c = await one<any>(`INSERT INTO categories (name,kind,parent_id,book_id) VALUES ($1,$2,$3,$4) RETURNING id`, [item, kind, g.id, HH]);
      cats[item] = c.id;
    }
  }

  console.log('Seeding vehicle...');
  const vehicle = await one<any>(
    `INSERT INTO vehicles (name,make,model,year,purchase_date,purchase_price,current_value,odometer_start,odometer_current,book_id)
     VALUES ('Daily Commuter','Toyota','RAV4',2021,$1,32000,24500,18000,46000,$2) RETURNING id`,
    [daysAgo(900), HH]
  );

  console.log('Seeding daily balances (~90 days)...');
  // simple trajectories so the net-worth chart has shape
  const start = { [checking.id]: 3800, [savings.id]: 15000, [invest.id]: 42000, [card.id]: 1900, [hsa.id]: 2600 };
  for (let d = 90; d >= 0; d -= 3) {
    const date = daysAgo(d);
    const t = (90 - d) / 90;
    const set = async (id: number, val: number) =>
      query(`INSERT INTO account_balances (account_id,as_of,balance,book_id) VALUES ($1,$2,$3,$4)
             ON CONFLICT (account_id,as_of) DO UPDATE SET balance=EXCLUDED.balance`, [id, date, val.toFixed(2), HH]);
    await set(checking.id, start[checking.id] + Math.sin(d / 7) * 400 + t * 600);
    await set(savings.id, start[savings.id] + t * 2500);
    await set(invest.id, start[invest.id] * (1 + t * 0.08) + Math.sin(d / 11) * 800);
    await set(card.id, start[card.id] + Math.sin(d / 5) * 300 - t * 400);
    await set(hsa.id, start[hsa.id] + t * 900);
  }

  console.log('Seeding budget...');
  const budget = await one<any>(`INSERT INTO budgets (name,period,book_id) VALUES ('Monthly Book','monthly',$1) RETURNING id`, [HH]);
  const lines: [string, number][] = [
    ['Salary', 8400], // planned income
    ['Groceries', 650], ['Dining', 250], ['Fuel', 180], ['Utilities', 320],
    ['Entertainment', 120], ['Shopping', 200], ['Auto Maintenance', 100],
  ];
  for (const [cat, amount] of lines) {
    await query(`INSERT INTO budget_lines (budget_id,category_id,amount,book_id) VALUES ($1,$2,$3,$4)`, [budget.id, cats[cat], amount, HH]);
  }

  console.log('Seeding transactions...');
  const txn = async (catName: string, amount: number, dayOffset: number, opts: any = {}) => {
    const r = await one<any>(
      `INSERT INTO transactions (account_id,category_id,txn_date,amount,direction,merchant,description,book_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        opts.account_id ?? card.id, cats[catName] ?? null,
        daysAgo(dayOffset), amount, opts.direction ?? 'expense',
        opts.merchant ?? null, opts.description ?? null, HH,
      ]
    );
    if (opts.vehicle_id) {
      await query(`INSERT INTO line_tags (transaction_id, kind, ref_id, book_id) VALUES ($1, 'vehicle', $2, $3)`, [r.id, opts.vehicle_id, HH]);
    }
    return r.id as number;
  };

  // income
  await txn('Salary', 4200, 30, { account_id: checking.id, direction: 'income', merchant: 'Employer' });
  await txn('Salary', 4200, 1, { account_id: checking.id, direction: 'income', merchant: 'Employer' });

  // groceries (some with receipts)
  const groceryTxn1 = await txn('Groceries', 86.42, 5, { merchant: 'Hy-Vee' });
  const groceryTxn2 = await txn('Groceries', 73.10, 18, { merchant: 'Aldi' });
  await txn('Groceries', 64.30, 26, { merchant: 'Hy-Vee' });
  await txn('Dining', 38.50, 4, { merchant: 'Local Diner' });
  await txn('Dining', 52.75, 12, { merchant: 'Sushi Bar' });
  await txn('Entertainment', 19.99, 8, { merchant: 'Streaming Co' });
  await txn('Shopping', 124.00, 15, { merchant: 'Target' });
  await txn('Health', 45.00, 20, { merchant: 'Pharmacy' });

  // vehicle-tagged expenses
  await txn('Fuel', 48.20, 3, { vehicle_id: vehicle.id, merchant: 'QuikTrip' });
  await txn('Fuel', 51.05, 17, { vehicle_id: vehicle.id, merchant: 'Casey\'s' });
  await txn('Fuel', 46.80, 28, { vehicle_id: vehicle.id, merchant: 'QuikTrip' });
  await txn('Auto Maintenance', 89.99, 22, { vehicle_id: vehicle.id, merchant: 'Jiffy Lube', description: 'Oil change + filter' });
  await txn('Auto Maintenance', 640.00, 60, { vehicle_id: vehicle.id, merchant: 'Toyota Service', description: 'Brakes + rotors' });
  await txn('Auto Insurance', 142.00, 10, { vehicle_id: vehicle.id, merchant: 'Geico', description: 'Monthly premium' });

  console.log('Seeding receipts with itemized products...');
  const addReceipt = async (txnId: number, merchant: string, day: number, items: any[]) => {
    const subtotal = items.reduce((s, i) => s + i.total_price, 0);
    const tax = +(subtotal * 0.07).toFixed(2);
    const total = +(subtotal + tax).toFixed(2);
    const r = await one<any>(
      `INSERT INTO receipts (transaction_id,merchant,purchased_at,subtotal,tax,total,book_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [txnId, merchant, daysAgo(day), subtotal, tax, total, HH]
    );
    for (const it of items) {
      await query(
        `INSERT INTO receipt_items (receipt_id,name,product_category,quantity,unit_price,total_price,book_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [r.id, it.name, it.product_category, it.quantity, it.unit_price, it.total_price, HH]
      );
    }
  };
  await addReceipt(groceryTxn1, 'Hy-Vee', 5, [
    { name: 'Whole milk 1gal', product_category: 'dairy', quantity: 1, unit_price: 3.79, total_price: 3.79 },
    { name: 'Eggs large dozen', product_category: 'dairy', quantity: 1, unit_price: 2.99, total_price: 2.99 },
    { name: 'Bananas', product_category: 'produce', quantity: 2.4, unit_price: 0.59, total_price: 1.42 },
    { name: 'Ground beef 1lb', product_category: 'meat', quantity: 2, unit_price: 5.49, total_price: 10.98 },
    { name: 'Cheddar cheese block', product_category: 'dairy', quantity: 1, unit_price: 6.49, total_price: 6.49 },
    { name: 'Coffee beans 12oz', product_category: 'pantry', quantity: 1, unit_price: 12.99, total_price: 12.99 },
  ]);
  await addReceipt(groceryTxn2, 'Aldi', 18, [
    { name: 'Whole milk 1gal', product_category: 'dairy', quantity: 1, unit_price: 3.29, total_price: 3.29 },
    { name: 'Eggs large dozen', product_category: 'dairy', quantity: 1, unit_price: 2.49, total_price: 2.49 },
    { name: 'Chicken breast 2lb', product_category: 'meat', quantity: 1, unit_price: 7.98, total_price: 7.98 },
    { name: 'Coffee beans 12oz', product_category: 'pantry', quantity: 1, unit_price: 9.99, total_price: 9.99 },
    { name: 'Pasta 1lb', product_category: 'pantry', quantity: 3, unit_price: 1.29, total_price: 3.87 },
  ]);

  console.log('Seeding subscriptions...');
  const sub = (name: string, amount: number, cycle: string, dueInDays: number, catName: string | null) =>
    query(
      `INSERT INTO subscriptions (name, amount, billing_cycle, next_due_date, category_id, account_id, status, book_id)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7)`,
      [name, amount, cycle, daysAgo(-dueInDays), catName ? cats[catName] : null, card.id, HH]
    );
  await sub('Netflix', 15.49, 'monthly', 12, 'Entertainment');
  await sub('Spotify', 11.99, 'monthly', 5, 'Entertainment');
  await sub('iCloud+', 2.99, 'monthly', 20, null);
  await sub('Amazon Prime', 139.0, 'yearly', 90, 'Shopping');

  console.log('Seeding goals...');
  await query(`INSERT INTO goals (name,goal_type,target_amount,account_id,target_date,book_id)
               VALUES ('Emergency fund','savings',25000,$1,$2,$3)`, [savings.id, daysAgo(-365), HH]);
  await query(`INSERT INTO goals (name,goal_type,target_amount,period,category_id,book_id)
               VALUES ('Dining out budget','reduce_spending',200,'monthly',$1,$2)`, [cats['Dining'], HH]);
  await query(`INSERT INTO goals (name,goal_type,target_amount,baseline_amount,account_id,book_id)
               VALUES ('Pay off Rewards Card','debt_payoff',0,3000,$1,$2)`, [card.id, HH]);

  console.log('Seeding utility accounts & invoices...');
  const ua = async (name: string, provider: string, type: string, unit: string | null, dueDay: number | null) =>
    one<any>(`INSERT INTO utility_accounts (name,provider,utility_type,usage_unit,due_day,book_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name, provider, type, unit, dueDay, HH]);
  const elec = await ua('Evergy Electric', 'Evergy', 'electricity', 'kWh', 12);
  const gas = await ua('Kansas Gas', 'Kansas Gas Service', 'gas', 'therm', 18);
  const water = await ua('City Water', 'City of Springfield', 'water', 'gallon', 5);
  const trash = await ua('City Trash', 'City of Springfield', 'trash', null, 5);

  const inv = async (provider: string, periodEnd: number, dueDays: number, paid: boolean) =>
    one<any>(
      `INSERT INTO utility_invoices (provider, invoice_date, period_start, period_end, due_date, paid, paid_date, book_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [provider, daysAgo(periodEnd), daysAgo(periodEnd + 30), daysAgo(periodEnd), daysAgo(dueDays), paid, paid ? daysAgo(dueDays + 2) : null, HH]
    );
  const line = (invId: number, acctId: number, amount: number, usage: number | null, unit: string | null) =>
    query(`INSERT INTO utility_invoice_lines (invoice_id, utility_account_id, amount, usage_quantity, usage_unit, book_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [invId, acctId, amount, usage, unit, HH]);

  const e1 = await inv('Evergy', 35, 20, true); await line(e1.id, elec.id, 118.40, 690, 'kWh');
  const e2 = await inv('Evergy', 5, -10, false); await line(e2.id, elec.id, 142.18, 845, 'kWh');
  const g1 = await inv('Kansas Gas Service', 5, -8, false); await line(g1.id, gas.id, 64.20, 38, 'therm');
  // A single city invoice covering water + trash, tracked as separate lines.
  const c1 = await inv('City of Springfield', 5, -12, false);
  await line(c1.id, water.id, 48.90, 4200, 'gallon');
  await line(c1.id, trash.id, 22.00, null, null);

  console.log('Seed complete.');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
