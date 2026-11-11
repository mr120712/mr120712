import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppShell, AppSurface } from '../../src/components/custom/app-ui/app-shell';
import { type DataColumn, DataTable } from '../../src/components/custom/app-ui/data-table';
import { FormSection } from '../../src/components/custom/app-ui/form-section';
import { PageHeader } from '../../src/components/custom/app-ui/page-header';

// Next's PostCSS configuration is checked by the build/browser, not Vitest.
vi.mock('@/components/custom/app-ui/app-ui.css', () => ({}));

const columns: DataColumn<{ id: string; name: string; total: number }>[] = [
  {
    id: 'name',
    header: 'Customer',
    cell: (row) => <a href={`/customers/${row.id}`}>{row.name}</a>,
  },
  { id: 'total', header: 'Total', cell: (row) => `${row.total} €`, align: 'right' },
];
const rows = [{ id: 'one', name: 'Aube', total: 80 }];
function render(node: React.ReactNode) {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(node);
  return container;
}

describe('application UI compositions', () => {
  it('keeps the supplied navigation and real page action inside one application shell', () => {
    const view = render(
      <AppShell
        brand={<a href="/dashboard">Aube</a>}
        navigation={
          <a href="/customers" aria-current="page">
            Customers
          </a>
        }
        navigationLabel="Workspace"
      >
        <PageHeader
          title="Customers"
          description="Your customer directory"
          actions={<a href="/customers/new">Add customer</a>}
        />
      </AppShell>,
    );
    expect(view.querySelectorAll('main')).toHaveLength(1);
    expect(view.querySelector('main h1')?.textContent).toBe('Customers');
    expect(view.querySelector('nav[aria-label="Workspace"] a')?.getAttribute('aria-current')).toBe(
      'page',
    );
    expect(view.querySelector('main a')?.getAttribute('href')).toBe('/customers/new');
  });

  it('supports composition inside an existing shell without nesting another main landmark', () => {
    const view = render(
      <main>
        <AppSurface density="compact">
          <PageHeader title="Settings" />
        </AppSurface>
      </main>,
    );
    expect(view.querySelectorAll('main')).toHaveLength(1);
    expect(view.querySelector('h1')?.textContent).toBe('Settings');
  });

  it('renders a named table with semantic headings and caller-owned links', () => {
    const view = render(
      <DataTable label="Customers" rows={rows} columns={columns} rowKey={(row) => row.id} />,
    );
    expect(view.querySelector('table')?.getAttribute('aria-label')).toBe('Customers');
    expect([...view.querySelectorAll('thead th')].map((node) => node.textContent)).toEqual([
      'Customer',
      'Total',
    ]);
    expect(view.querySelector('th')?.getAttribute('scope')).toBe('col');
    expect(view.querySelector('tbody a')?.getAttribute('href')).toBe('/customers/one');
    expect(view.querySelector('tbody')?.textContent).toContain('80 €');
  });

  it('distinguishes loading, error, empty and populated states without stale success rows', () => {
    const base = {
      label: 'Customers',
      rows,
      columns,
      rowKey: (row: (typeof rows)[number]) => row.id,
    };
    const loading = render(<DataTable {...base} loading loadingLabel="Loading customers" />);
    expect(loading.querySelector('output')?.textContent).toContain('Loading customers');
    expect(loading.textContent).not.toContain('Aube');
    const failed = render(
      <DataTable
        {...base}
        error={
          <p>
            Customers could not be loaded. <button type="button">Retry</button>
          </p>
        }
      />,
    );
    expect(failed.querySelector('[role="alert"]')?.textContent).toContain(
      'Customers could not be loaded',
    );
    expect(failed.querySelector('button')?.textContent).toBe('Retry');
    expect(failed.textContent).not.toContain('Aube');
    const empty = render(
      <DataTable
        {...base}
        rows={[]}
        empty={
          <p>
            No customers yet. <a href="/customers/new">Add one</a>
          </p>
        }
      />,
    );
    expect(empty.querySelector('a')?.getAttribute('href')).toBe('/customers/new');
    expect(empty.querySelector('td')?.getAttribute('colspan')).toBe('2');
  });

  it('keeps form sections semantic and leaves field labels and submission with the caller', () => {
    const view = render(
      <form>
        <FormSection title="Workspace" description="Shown to your team">
          <label htmlFor="workspace-name">Name</label>
          <input id="workspace-name" name="name" defaultValue="Aube" />
          <button type="submit">Save</button>
        </FormSection>
      </form>,
    );
    expect(view.querySelectorAll('form')).toHaveLength(1);
    expect(view.querySelector('section[aria-label="Workspace"]')).not.toBeNull();
    expect(view.querySelector('label')?.htmlFor).toBe(view.querySelector('input')?.id);
    expect(view.querySelector('input')?.value).toBe('Aube');
    expect(view.querySelector('button')?.type).toBe('submit');
  });
});
