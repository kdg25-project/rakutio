type BrandLogoProps = {
  className?: string
}

export function BrandLogo({ className }: BrandLogoProps) {
  return (
    <span className={className ? `brand-logo ${className}` : 'brand-logo'}>
      <img src="/rakutio-logo.svg" alt="Rakutio" />
    </span>
  )
}
