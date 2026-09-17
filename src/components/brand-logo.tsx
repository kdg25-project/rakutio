type BrandLogoProps = {
  className?: string
}

export function BrandLogo({ className }: BrandLogoProps) {
  return <span className={className ? `brand-logo ${className}` : 'brand-logo'}>Rakutio</span>
}
