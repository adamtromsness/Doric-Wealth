import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { EntityDocuments } from './EntityDocuments';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    apiStream: vi.fn(), apiDownload: vi.fn(), apiBlob: vi.fn(),
  };
});
import { api } from '../api';

const BASE = '/vehicles/1';
const DOC_TYPES: [string, string][] = [['title', 'Title'], ['registration', 'Registration'], ['other', 'Other']];

// 6 docs -> two pages of 5, mixed types incl. an unknown type ("weird") for typeLabel fallback.
const docs = [
  { id: 1, name: 'Title Doc', file_name: 'title.pdf', file_mime: 'application/pdf', created_at: '2026-01-05', doc_type: 'title' },
  { id: 2, name: null, file_name: 'reg.pdf', file_mime: 'application/pdf', created_at: '2026-02-05', doc_type: 'registration' },
  { id: 3, name: 'Other A', file_name: 'a.pdf', file_mime: 'application/pdf', created_at: '2026-03-05', doc_type: 'other' },
  { id: 4, name: 'Other B', file_name: 'b.pdf', file_mime: 'application/pdf', created_at: '2026-03-06', doc_type: 'other' },
  { id: 5, name: 'Weird', file_name: 'w.pdf', file_mime: 'application/pdf', created_at: '2026-03-07', doc_type: 'weird' },
  { id: 6, name: null, file_name: null, file_mime: null, created_at: '2026-03-08', doc_type: null },
];

const setList = (list: any[]) =>
  (api.get as any).mockImplementation((path: string) =>
    path === `${BASE}/documents` ? Promise.resolve(list) : Promise.resolve([]));

const renderPage = () => render(<MemoryRouter><EntityDocuments basePath={BASE} docTypes={DOC_TYPES} /></MemoryRouter>);

describe('EntityDocuments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.post as any).mockResolvedValue({});
    (api.put as any).mockResolvedValue({});
    (api.del as any).mockResolvedValue({});
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the empty state', async () => {
    setList([]);
    renderPage();
    await waitFor(() => expect(screen.getByText('No documents yet.')).toBeInTheDocument());
  });

  it('lists documents grouped/sorted and paginates', async () => {
    const user = userEvent.setup();
    setList(docs);
    renderPage();
    await waitFor(() => expect(screen.getByText('Title Doc')).toBeInTheDocument());
    // typeLabel in the table: known ("Title"/"Registration"). Scope to table cells
    // to avoid matching the <option> labels in the type <select>.
    const cells = () => Array.from(document.querySelectorAll('td.muted')).map((td) => td.textContent);
    expect(cells()).toContain('Title');
    expect(cells()).toContain('Registration');
    // Sort order: by docType index (title, registration, other, unknown→99) then
    // created_at desc → [title(1), reg(2), other:6,4,3], then weird(5) spills to page 2.
    expect(screen.queryByText('Weird')).toBeNull();
    // Pager: go to next page
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Weird')).toBeInTheDocument());
  });

  it('uploads a new document', async () => {
    const user = userEvent.setup();
    setList([]);
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('No documents yet.')).toBeInTheDocument());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    await user.upload(input, file);
    // label now reads "Upload"
    const uploadLabel = await screen.findByText('Upload');
    await user.click(uploadLabel);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `${BASE}/documents`,
      expect.objectContaining({ file_name: 'a.txt', file_mime: 'text/plain', doc_type: 'other', name: 'a.txt' }),
    ));
  });

  it('edits a document name and type then updates', async () => {
    const user = userEvent.setup();
    setList(docs);
    renderPage();
    await waitFor(() => expect(screen.getByText('Title Doc')).toBeInTheDocument());

    await user.click(screen.getAllByTitle('Edit name & type')[0]);
    const nameInput = screen.getByPlaceholderText('Document name') as HTMLInputElement;
    expect(nameInput.value).toBe('Title Doc');
    // Update disabled until changed
    const updateBtn = screen.getByRole('button', { name: 'Update' });
    expect(updateBtn).toBeDisabled();
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed');
    expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${BASE}/documents/1`, expect.objectContaining({ name: 'Renamed', doc_type: 'title' })));
  });

  it('replaces the file while editing', async () => {
    const user = userEvent.setup();
    setList(docs);
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('Title Doc')).toBeInTheDocument());

    await user.click(screen.getAllByTitle('Edit name & type')[0]);
    // The hidden "replace file" input is the last file input while editing.
    const inputs = container.querySelectorAll('input[type="file"]');
    const replaceInput = inputs[inputs.length - 1] as HTMLInputElement;
    const file = new File(['y'], 'new.pdf', { type: 'application/pdf' });
    await user.upload(replaceInput, file);
    await waitFor(() => expect(screen.getByText(/New file: new.pdf/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(
      `${BASE}/documents/1`,
      expect.objectContaining({ file_name: 'new.pdf', file_mime: 'application/pdf' }),
    ));
  });

  it('cancels edit mode', async () => {
    const user = userEvent.setup();
    setList(docs);
    renderPage();
    await waitFor(() => expect(screen.getByText('Title Doc')).toBeInTheDocument());
    await user.click(screen.getAllByTitle('Edit name & type')[0]);
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
  });

  it('deletes a document and resets the form if it was being edited', async () => {
    const user = userEvent.setup();
    setList(docs);
    renderPage();
    await waitFor(() => expect(screen.getByText('Title Doc')).toBeInTheDocument());

    await user.click(screen.getAllByTitle('Edit name & type')[0]);
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
    await user.click(screen.getAllByTitle('Delete')[0]);
    await waitFor(() => expect(api.del).toHaveBeenCalledWith(`${BASE}/documents/1`));
    // editing that id -> form reset
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
  });

  it('shows an error when upload fails', async () => {
    const user = userEvent.setup();
    setList([]);
    (api.post as any).mockRejectedValueOnce(new Error('upload boom'));
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('No documents yet.')).toBeInTheDocument());
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'a.txt', { type: 'text/plain' }));
    await user.click(await screen.findByText('Upload'));
    await waitFor(() => expect(screen.getByText('upload boom')).toBeInTheDocument());
  });
});
