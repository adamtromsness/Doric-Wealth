import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import Changelog from './Changelog';

const MD = `# Changelog

## [Unreleased]

## [1.2.1] - 2026-10-01

### Fixed
- Errors now show their **actual message** (#1).

## [1.2.0] - 2026-09-30

### Changed
- Add Asset uses \`/other-assets/new\`.
`;

describe('Changelog page', () => {
  it('shows the running version and each release with its notes', () => {
    render(<Changelog markdown={MD} version="1.2.1" />);
    expect(screen.getByRole('heading', { name: "What's New" })).toBeInTheDocument();
    expect(screen.getByText('v1.2.1', { selector: 'strong' })).toBeInTheDocument();

    const current = screen.getByLabelText('Release v1.2.1');
    expect(within(current).getByText('Current')).toBeInTheDocument();
    expect(within(current).getByText('Fixed')).toBeInTheDocument();
    expect(within(current).getByText('actual message').tagName).toBe('STRONG');
    expect(within(current).getByRole('link', { name: '#1' })).toHaveAttribute('href', 'https://github.com/adamtromsness/Doric-Wealth/issues/1');

    const older = screen.getByLabelText('Release v1.2.0');
    expect(within(older).queryByText('Current')).toBeNull();
    expect(within(older).getByText('/other-assets/new').tagName).toBe('CODE');
    // The empty Unreleased section isn't shown.
    expect(screen.queryByLabelText('Release Unreleased')).toBeNull();
  });

  it('shows an empty state when there are no release notes', () => {
    render(<Changelog markdown="# Changelog\n" version="1.0.0" />);
    expect(screen.getByText('No release notes yet.')).toBeInTheDocument();
  });

  it('defaults to the built-in changelog and version', () => {
    render(<Changelog />);
    expect(screen.getByText(`v${__APP_VERSION__}`, { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByLabelText(`Release v${__APP_VERSION__}`)).toBeInTheDocument();
  });
});
