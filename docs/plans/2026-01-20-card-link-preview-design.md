# Card Link Preview Feature

Inline card name hover previews in LLM chat responses.

## Overview

When the LLM mentions Magic cards in responses, render card names as hoverable links that show the full card image on hover. Similar to Scryfall bots on Reddit/Discord.

**Example:** "Jack picked [[Lightning Bolt]] at pick 5" renders "Lightning Bolt" as a styled link with hover preview.

## Design Decisions

- **Markup format:** Double brackets `[[Card Name]]` - familiar convention from Scryfall/Discord
- **Resolution:** Client-side - card data already loaded, no added API latency
- **Image lookup:** Local card data first, Scryfall API fallback
- **Visual style:** Subtle dotted underline to indicate hover capability

## Implementation

### 1. LLM Prompt Changes

Add to both `src/cli/explorePrompt.ts` and `src/app/api/chat/route.ts`:

```
## Card Name Formatting
Wrap Magic card names in double brackets: [[Lightning Bolt]], [[Counterspell]].
This enables hover previews for readers. Use exact card names.
```

### 2. CardLink Component

Create `src/app/components/CardLink.tsx`:

```tsx
export function CardLink({ name }: { name: string }) {
  const imageUrl = useCardImage(name);
  const [showPreview, setShowPreview] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLSpanElement>(null);

  const handleMouseEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const left = Math.min(rect.right + 8, window.innerWidth - 340);
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - 480));
      setPosition({ top, left });
    }
    setShowPreview(true);
  };

  return (
    <span
      ref={ref}
      className="underline decoration-dotted decoration-zinc-400 cursor-help"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setShowPreview(false)}
    >
      {name}
      {showPreview && imageUrl && (
        <span className="fixed z-50" style={{ top: position.top, left: position.left }}>
          <Image src={imageUrl} alt={name} width={320} height={448} />
        </span>
      )}
    </span>
  );
}
```

### 3. useCardImage Hook

Create `src/app/hooks/useCardImage.ts`:

```tsx
export function useCardImage(cardName: string): string | null {
  const { cards } = useCardData();

  // Normalize name (strip numeric suffixes)
  const normalized = cardName.replace(/\s+\d+$/, '');

  // Check local data first
  const card = cards.find(c =>
    c.cardName.toLowerCase() === normalized.toLowerCase()
  );
  if (card?.scryfall?.imageUri) {
    return card.scryfall.imageUri;
  }

  // Fallback: Scryfall direct image URL
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(normalized)}&format=image`;
}
```

### 4. Markdown Integration

Update `src/app/components/QueryBox.tsx`:

```tsx
import rehypeRaw from 'rehype-raw';
import { CardLink } from './CardLink';

function processCardLinks(text: string): string {
  return text.replace(
    /\[\[([^\]]+)\]\]/g,
    '<card-link name="$1">$1</card-link>'
  );
}

// In render:
<ReactMarkdown
  rehypePlugins={[rehypeRaw]}
  components={{
    'card-link': ({ node, ...props }) => (
      <CardLink name={props.name as string} />
    )
  }}
>
  {processCardLinks(message.content)}
</ReactMarkdown>
```

### 5. Dependencies

Add `rehype-raw`:

```bash
pnpm add rehype-raw
```

## Files Changed

**Modified:**
- `src/cli/explorePrompt.ts` - Card name formatting instruction
- `src/app/api/chat/route.ts` - Card name formatting instruction
- `src/app/components/QueryBox.tsx` - Markdown processing and component mapping

**Created:**
- `src/app/components/CardLink.tsx` - Hoverable card link component
- `src/app/hooks/useCardImage.ts` - Image URL resolution

## Future Considerations

- Footnote styling: `rehype-raw` enables `<sup>` tags if we want superscript footnotes later
- Card preview caching: Could cache Scryfall fallback results in localStorage
- Mobile: Touch-friendly alternative to hover (tap to show, tap elsewhere to dismiss)
