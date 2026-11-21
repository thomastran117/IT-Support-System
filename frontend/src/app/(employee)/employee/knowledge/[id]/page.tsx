import type { Metadata } from 'next';
import { ArticleView } from '@/components/knowledge/ArticleView';

export const metadata: Metadata = { title: 'Article' };

export default function ArticlePage() {
  return <ArticleView backHref="/employee/knowledge" />;
}
