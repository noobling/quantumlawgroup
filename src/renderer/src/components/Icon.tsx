import { icons, HelpCircle, type LucideProps } from 'lucide-react'

interface Props extends LucideProps {
  name: string
}

/** Render a lucide icon by its string name (used by data-driven workflows). */
export default function Icon({ name, ...props }: Props): JSX.Element {
  const Cmp = (icons as Record<string, React.ComponentType<LucideProps>>)[name] ?? HelpCircle
  return <Cmp {...props} />
}
