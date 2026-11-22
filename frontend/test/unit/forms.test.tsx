// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncButton } from '../../src/components/forms/AsyncButton';
import { FormField } from '../../src/components/forms/FormField';
import { SubmitError } from '../../src/components/forms/SubmitError';
import { Pagination } from '../../src/components/ui/Pagination';
import { ApiError, NetworkError } from '../../src/lib/auth/client';
import { toFailure } from '../../src/lib/forms/failure';
import { useSubmit } from '../../src/lib/forms/useSubmit';

afterEach(cleanup);

describe('FormField', () => {
  it('links label, hint, counter and error to the control', () => {
    render(
      <FormField
        id="title"
        label="Title"
        hint="Short"
        error="Required"
        footerId="title-count"
        footer={<p id="title-count">0 of 5</p>}
      >
        {(control) => <input {...control} />}
      </FormField>,
    );
    const input = screen.getByLabelText('Title');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('title-hint title-count title-error');
    expect(screen.getByText('Required').id).toBe('title-error');
  });

  it('is valid and undescribed without an error', () => {
    render(
      <FormField id="a" label="A">
        {(control) => <input {...control} />}
      </FormField>,
    );
    const input = screen.getByLabelText('A');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('AsyncButton', () => {
  it('is disabled and relabelled while pending', () => {
    render(
      <AsyncButton pending pendingLabel="Saving…">
        Save
      </AsyncButton>,
    );
    const button = screen.getByRole('button', { name: 'Saving…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});

describe('SubmitError', () => {
  it('announces the failure and offers a retry for an outage', async () => {
    const onRetry = vi.fn();
    render(<SubmitError failure={toFailure(new NetworkError())} onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toContain('Unable to reach the server');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('offers reload, not retry, for a version conflict', () => {
    const failure = toFailure(new ApiError(409, 'x', { code: 'VERSION_CONFLICT' }));
    render(<SubmitError failure={failure} onRetry={() => {}} onReload={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload latest' })).toBeTruthy();
  });

  it('renders nothing without a failure', () => {
    const { container } = render(<SubmitError failure={null} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('useSubmit', () => {
  it('ignores a second call while one is running', async () => {
    const { result } = renderHook(() => useSubmit());
    let release!: () => void;
    const work = vi.fn(() => new Promise<string>((resolve) => (release = () => resolve('ok'))));
    let first!: Promise<unknown>;
    act(() => {
      first = result.current.run(work);
    });
    await expect(result.current.run(work)).resolves.toBeNull();
    expect(work).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(true);
    await act(async () => {
      release();
      await first;
    });
    expect(result.current.pending).toBe(false);
  });

  it('records a failure; retry resends the same work and clears it on success', async () => {
    const { result } = renderHook(() => useSubmit());
    const work = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce('saved');
    await act(async () => {
      await result.current.run(work);
    });
    expect(result.current.failure).toMatchObject({ kind: 'network', retryable: true });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.retry();
    });
    expect(work).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ ok: true, value: 'saved' });
    expect(result.current.failure).toBeNull();
  });
});

describe('Pagination', () => {
  it('shows the range and moves by page size', async () => {
    const onChange = vi.fn();
    render(
      <Pagination
        offset={20}
        limit={20}
        count={20}
        total={65}
        nextOffset={40}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Showing 21–40 of 65');
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onChange).toHaveBeenLastCalledWith(0);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onChange).toHaveBeenLastCalledWith(40);
  });

  it('disables Previous on the first page and Next on the last', () => {
    render(
      <Pagination
        offset={0}
        limit={20}
        count={3}
        total={3}
        nextOffset={null}
        onChange={() => {}}
      />,
    );
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Showing 1–3 of 3');
  });
});
