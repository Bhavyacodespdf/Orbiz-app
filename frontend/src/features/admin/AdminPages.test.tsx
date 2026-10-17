import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

const admin = makeUser({ id: 'me', roles: ['STUDENT', 'ADMIN'], displayName: 'Admin' });
const userRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'u2',
  email: 'asha@example.com',
  displayName: 'Asha',
  emailVerified: true,
  status: 'ACTIVE',
  signInMethod: 'GOOGLE',
  roles: ['STUDENT', 'POS'],
  eligibleFor: { MANAGER: false, POS: true, ADMIN: true },
  assignments: [{ id: 'a1', role: 'POS', outlet: { id: 'o1', name: 'Night Owl Café' } }],
  createdAt: '2026-10-16T08:00:00.000Z',
  ...overrides,
});

describe('admin users & roles', () => {
  it('offers only roles the allowlists permit, and never self-removal of admin', async () => {
    mockApi({
      'GET /auth/me': signedInAs(admin),
      'GET /admin/users': () => ({
        status: 200,
        body: {
          users: [
            userRow(),
            userRow({
              id: 'me',
              email: 'admin@example.com',
              displayName: 'Admin',
              roles: ['STUDENT', 'ADMIN'],
              assignments: [],
            }),
          ],
          nextCursor: null,
        },
      }),
    });
    renderRoute('/admin');
    const users = await screen.findByRole('list', { name: 'Users' });
    const select = within(users).getByLabelText('Role to give Asha');
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Add a role…', 'Administrator']); // MANAGER not allowlisted, POS already held
    expect(within(users).getByText('POS / Cashier at Night Owl Café')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove Administrator from Admin' }),
    ).not.toBeInTheDocument();
  });

  it('requires a reason to remove a role', async () => {
    const bodies: unknown[] = [];
    mockApi({
      'GET /auth/me': signedInAs(admin),
      'GET /admin/users': () => ({ status: 200, body: { users: [userRow()], nextCursor: null } }),
      'POST /admin/users/u2/roles/POS/revoke': (init) => {
        bodies.push(JSON.parse(String(init.body)));
        return { status: 200, body: { changed: true, sessionsEnded: 1 } };
      },
    });
    renderRoute('/admin');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove POS / Cashier from Asha' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Remove POS / Cashier from Asha?' });
    expect(within(dialog).getByRole('button', { name: 'Remove role' })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Left the team');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove role' }));
    await vi.waitFor(() => expect(bodies).toEqual([{ reason: 'Left the team' }]));
  });
});

describe('admin outlets', () => {
  it('creates an outlet and assigns staff to it', async () => {
    const calls: [string, unknown][] = [];
    mockApi({
      'GET /auth/me': signedInAs(admin),
      'GET /admin/outlets': () => ({
        status: 200,
        body: {
          outlets: [
            {
              id: 'o1',
              slug: 'n',
              name: 'Night Owl Café',
              description: '',
              location: 'Library',
              imageUrl: null,
              status: 'OPEN',
              acceptingOrders: true,
              isSample: true,
              isActive: true,
            },
          ],
        },
      }),
      'POST /admin/outlets': (init) => {
        calls.push(['create', JSON.parse(String(init.body))]);
        return { status: 201, body: {} };
      },
      'GET /admin/outlets/o1/staff': () => ({ status: 200, body: { staff: [] } }),
      'POST /admin/outlets/o1/staff': (init) => {
        calls.push(['assign', JSON.parse(String(init.body))]);
        return { status: 201, body: {} };
      },
    });
    renderRoute('/admin/outlets');
    await userEvent.click(await screen.findByRole('button', { name: 'New outlet' }));
    const dialog = await screen.findByRole('dialog', { name: 'New outlet' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Dosa Point');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create outlet' }));

    await userEvent.click(screen.getByRole('button', { name: 'Staff' }));
    await userEvent.type(await screen.findByLabelText('Staff email'), 'cashier@example.com');
    await userEvent.selectOptions(screen.getByLabelText('As'), 'POS');
    await userEvent.click(screen.getByRole('button', { name: 'Assign' }));
    await vi.waitFor(() =>
      expect(calls).toEqual([
        ['create', { name: 'Dosa Point', location: '', description: '' }],
        ['assign', { email: 'cashier@example.com', role: 'POS' }],
      ]),
    );
  });
});

describe('audit log', () => {
  it('lists entries with their actor and filters by action', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': signedInAs(admin),
      'GET /admin/audit-logs/actions': () => ({
        status: 200,
        body: { actions: ['ROLE_GRANTED', 'ORDER_REJECTED'] },
      }),
      'GET /admin/audit-logs': () => ({
        status: 200,
        body: {
          entries: [
            {
              id: 'e1',
              actorType: 'USER',
              actor: { id: 'me', email: 'admin@example.com', displayName: 'Admin' },
              action: 'ROLE_GRANTED',
              entityType: 'User',
              entityId: '12345678-aaaa',
              metadata: { role: 'POS' },
              createdAt: '2026-10-16T08:00:00.000Z',
            },
            {
              id: 'e2',
              actorType: 'CLI',
              actor: null,
              action: 'ROLE_GRANTED',
              entityType: 'User',
              entityId: '87654321-bbbb',
              metadata: null,
              createdAt: '2026-10-16T07:00:00.000Z',
            },
          ],
          nextCursor: null,
        },
      }),
    });
    renderRoute('/admin/audit');
    const list = await screen.findByRole('list', { name: 'Audit entries' });
    expect(list).toHaveTextContent('Admin (admin@example.com)');
    expect(list).toHaveTextContent('Server command line');
    await userEvent.selectOptions(
      await screen.findByLabelText('Filter by action'),
      'ORDER_REJECTED',
    );
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('action=ORDER_REJECTED')),
      ).toBe(true),
    );
  });

  describe('admin no-shows', () => {
    const failed = {
      orderId: 'ord1',
      pickupCode: 'N-007',
      outlet: 'Night Owl Café',
      orderStatus: 'READY',
      status: 'FAILED',
      attempts: 3,
      lastError: 'Database unavailable',
      pickupDeadline: '2026-10-16T08:10:00.000Z',
      processedAt: null,
      refundPaise: 0,
      convenienceFeePaise: 0,
      restockedUnits: 0,
      updatedAt: '2026-10-16T08:15:00.000Z',
    };

    it('lists failed settlements and retries without sending any amount', async () => {
      const retries: (BodyInit | null | undefined)[] = [];
      mockApi({
        'GET /auth/me': signedInAs(admin),
        'GET /admin/no-shows': () => ({ status: 200, body: { settlements: [failed] } }),
        'POST /admin/no-shows/ord1/retry': (init) => {
          retries.push(init.body);
          return { status: 200, body: { processed: true, order: {} } };
        },
      });
      renderRoute('/admin/no-shows');
      expect(await screen.findByText('N-007')).toBeInTheDocument();
      expect(screen.getByText(/Last error: Database unavailable/)).toBeInTheDocument();
      expect(screen.getByText(/3 attempts/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('status')).toHaveTextContent('Processed.');
      expect(retries).toEqual([undefined]);
    });

    it('explains when a retry had nothing to do', async () => {
      mockApi({
        'GET /auth/me': signedInAs(admin),
        'GET /admin/no-shows': () => ({ status: 200, body: { settlements: [failed] } }),
        'POST /admin/no-shows/ord1/retry': () => ({
          status: 200,
          body: { processed: false, order: {} },
        }),
      });
      renderRoute('/admin/no-shows');
      await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('status')).toHaveTextContent(/Nothing to do/);
    });
  });
});
