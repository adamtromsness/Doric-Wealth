import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthShell } from './AuthShell';

describe('AuthShell', () => {
  it('renders the brand, title and children', () => {
    render(<AuthShell title="Sign in"><p>form body</p></AuthShell>);
    expect(screen.getByText('Doric')).toBeInTheDocument();
    expect(screen.getByText('Sign in')).toBeInTheDocument();
    expect(screen.getByText('form body')).toBeInTheDocument();
  });

  it('renders the subtitle when provided', () => {
    render(<AuthShell title="T" subtitle="Welcome back."><span>x</span></AuthShell>);
    expect(screen.getByText('Welcome back.')).toBeInTheDocument();
  });

  it('omits the subtitle when not provided', () => {
    const { container } = render(<AuthShell title="T"><span>x</span></AuthShell>);
    expect(container.querySelector('.subtitle')).toBeNull();
  });
});
