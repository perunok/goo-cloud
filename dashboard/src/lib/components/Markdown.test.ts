import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import Markdown from './Markdown.svelte';

describe('Markdown component', () => {
  it('renders structure with real elements', () => {
    const { container } = render(Markdown, {
      props: { source: '# Plan\n\n- [x] **ship** it\n\n| a |\n|---|\n| `x` |\n\n[site](https://example.com)' },
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Plan' })).toBeInTheDocument();
    expect(container.querySelector('li strong')?.textContent).toBe('ship');
    expect(screen.getByRole('checkbox', { name: 'Done' })).toBeChecked();
    expect(container.querySelector('td code')?.textContent).toBe('x');
    const link = screen.getByRole('link', { name: 'site' });
    expect(link).toHaveAttribute('href', 'https://example.com/');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('never turns note content into markup', () => {
    const evil = [
      '<img src=x onerror="window.__pwned=1">',
      '<script>window.__pwned=1</script>',
      '[click](javascript:window.__pwned=1)',
      '![x](https://evil.example/x.png)',
      '<a href="javascript:alert(1)">a</a>',
      '```\n</code></pre><script>window.__pwned=1</script>\n```',
    ].join('\n\n');
    const { container } = render(Markdown, { props: { source: evil } });
    expect(container.querySelector('script, img, iframe, object, embed, style')).toBeNull();
    expect([...container.querySelectorAll('*')].some((el) => [...el.attributes].some((a) => a.name.startsWith('on')))).toBe(false);
    for (const a of container.querySelectorAll('a')) expect(a.getAttribute('href')).toMatch(/^(https?:|mailto:)/);
    expect(container.textContent).toContain('<img src=x onerror="window.__pwned=1">');
    expect(screen.getByText('click').tagName).toBe('SPAN');
    expect(screen.getByRole('link', { name: 'Image: x' })).toHaveAttribute('href', 'https://evil.example/x.png');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
