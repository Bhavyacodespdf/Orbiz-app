# CampusCart design system: "Late-Night Diner"

Tokens are defined once in [`frontend/src/styles/index.css`](../frontend/src/styles/index.css)
(Tailwind v4 `@theme`). In development, a live reference of every component is at
<http://localhost:5173/design>. That page is excluded from production builds.

## Colour

| Token          | Hex       | Use                                                  |
| -------------- | --------- | ---------------------------------------------------- |
| `cream-100`    | `#FDFBF7` | Page background                                      |
| `cream-50`     | `#FFFEFB` | Raised surfaces (panels, dialogs, tickets)           |
| `chili-500`    | `#C83E2A` | Primary actions, brand accent                        |
| `chili-600`    | `#A93221` | Primary hover; red text on cream                     |
| `mustard-500`  | `#E6A133` | Highlights: active nav, console selection            |
| `mustard-800`  | `#7A5410` | Text on mustard-50 (test-mode banner)                |
| `espresso-900` | `#2B1E1A` | Body text, dark chrome (consoles, POS, balance card) |
| `espresso-500` | `#6B5952` | Secondary text                                       |
| `espresso-400` | `#8A766E` | **Decoration and borders only.** Fails AA for text   |
| `success-600`  | `#2F7A4B` | Open outlets, paid, live connection                  |

Checked WCAG contrast ratios for text: espresso-900 on cream 15.6, espresso-500 on cream 6.4, white
on chili-500 5.0, chili-600 on cream 6.4, espresso-900 on mustard-500 7.3, success-600 on cream
5.1. On dark backgrounds the wordmark uses `chili-400`.

## Type

- **Bricolage Grotesque** (variable, self-hosted) for headings, the wordmark and the outlet status
  sign.
- **Figtree** (variable, self-hosted) for everything else.
- `tabular` utility for prices, pickup codes and anything that lines up in columns.
- Money is formatted only by `formatINR(paise)` in `src/lib/money.ts`. It rejects non-integer
  paise.

## Components

| Component                                         | Where                                   | Notes                                                                     |
| ------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| `Button`, `ButtonLink`                            | `components/ui/Button.tsx`              | primary / secondary / ghost / danger; `loading` blocks repeat clicks      |
| `TextField`                                       | `components/ui/TextField.tsx`           | Label, hint and error wired to `aria-describedby` / `aria-invalid`        |
| `Badge`                                           | `components/ui/Badge.tsx`               | Status labels                                                             |
| `StatusSign`                                      | `components/ui/StatusSign.tsx`          | Diner "OPEN / PAUSED / CLOSED" sign                                       |
| `Panel`                                           | `components/ui/Panel.tsx`               | Standard raised surface. Use sparingly                                    |
| `Ticket`, `TicketLine`                            | `components/ui/Ticket.tsx`              | Receipt with perforated edge, for order confirmation and tracking         |
| `Dialog`, `ConfirmDialog`                         | `components/ui/Dialog.tsx`              | Native `<dialog>`. Confirm starts focus on Cancel                         |
| `Price`, `Wordmark`                               | `components/ui/`                        |                                                                           |
| `Spinner`, `Skeleton`                             | `components/feedback/`                  | Loading. Skeletons never contain fake content                             |
| `EmptyState`                                      | `components/feedback/`                  | What will appear here and what to do next                                 |
| `SelectField`, `SearchField`                      | `components/ui/`                        | Native select with label/hint/error; rounded search box with clear button |
| `DietaryMark`                                     | `components/ui/DietaryMark.tsx`         | Indian veg / egg / non-veg square marks, labelled for screen readers      |
| `QuantityStepper`, `AddToCartControl`, `CartBar`  | `features/cart/`                        | Server-backed cart controls                                               |
| `OrderProgress`                                   | `features/orders/`                      | Placed → Accepted → Preparing → Ready → Collected                         |
| `OrderCard`, `PaymentBadge`, `OrderActionsDialog` | `features/staff/`                       | Staff queue tickets and the order action dialog                           |
| `ErrorState`, `describeError`                     | `components/feedback/`, `lib/errors.ts` | Safe, plain-language errors with retry                                    |
| `ToastProvider`, `useToast`                       | `components/feedback/`                  | Live-region notifications that auto-dismiss after 5 s                     |
| `ConnectionStatus`                                | `components/feedback/`                  | live / connecting / offline / unavailable; `compact` on phones            |
| `TestModeBanner`                                  | `components/feedback/`                  | Required wherever simulated money appears                                 |

## Shells

| Shell   | Route     | Layout                                                                         |
| ------- | --------- | ------------------------------------------------------------------------------ |
| Student | `/`       | Top nav (≥768px) or bottom tab bar (phones); the Cart button is always visible |
| Manager | `/manage` | Dark sidebar (≥1024px) or dark top bar with scrollable tabs; order board       |
| POS     | `/pos`    | Full-width dark header, large 48px+ tabs, counter-tablet friendly              |
| Admin   | `/admin`  | Same console shell as Manager                                                  |

## Rules

- No sample data presented as real. Development seed rows carry a "Sample data" badge, and
  simulated money always carries a test-mode label.
- Controls that can't work are **disabled** with a reason, not fake. For example, "Hand over" is
  disabled until a counter payment is recorded.
- State is never shown by fading text with opacity, which fails contrast checks. Use colour,
  strikethrough or a badge instead (Phase 8 accessibility review).
- Motion is limited to short fades and toast slides, and is turned off under
  `prefers-reduced-motion`.
- Icons come from Lucide only. No emoji icons.
