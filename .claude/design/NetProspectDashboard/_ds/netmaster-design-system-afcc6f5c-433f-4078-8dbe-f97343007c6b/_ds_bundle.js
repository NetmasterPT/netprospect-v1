/* @ds-bundle: {"format":3,"namespace":"NetmasterDesignSystem_afcc6f","components":[{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"IconTile","sourcePath":"components/core/IconTile.jsx"},{"name":"Input","sourcePath":"components/core/Input.jsx"},{"name":"FAQItem","sourcePath":"components/marketing/FAQItem.jsx"},{"name":"FeatureCard","sourcePath":"components/marketing/FeatureCard.jsx"},{"name":"PricingCard","sourcePath":"components/marketing/PricingCard.jsx"},{"name":"SectionHeader","sourcePath":"components/marketing/SectionHeader.jsx"},{"name":"TestimonialCard","sourcePath":"components/marketing/TestimonialCard.jsx"}],"sourceHashes":{"components/core/Badge.jsx":"13a3ce303984","components/core/Button.jsx":"50b7961fcad9","components/core/Card.jsx":"895ab3dc4d0f","components/core/IconTile.jsx":"8b36af5bc2b2","components/core/Input.jsx":"eed65dbac21c","components/marketing/FAQItem.jsx":"1c1656abe35e","components/marketing/FeatureCard.jsx":"375b42b21288","components/marketing/PricingCard.jsx":"c10b97c65f8b","components/marketing/SectionHeader.jsx":"9091262ab181","components/marketing/TestimonialCard.jsx":"45fecbf436a2","ui_kits/website/Site.jsx":"c855f16ef677","ui_kits/website/chrome.jsx":"82e44cd1538f","ui_kits/website/sections.jsx":"55fcb19e41bc"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.NetmasterDesignSystem_afcc6f = window.NetmasterDesignSystem_afcc6f || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * NetMaster Badge — small uppercase pill. Default is the red "MAIS POPULAR"
 * flag; also neutral and dark tones, with an optional soft (tinted) fill.
 */
function Badge({
  children,
  tone = 'brand',
  soft = false,
  style = {},
  ...rest
}) {
  const tones = {
    brand: soft ? {
      background: 'var(--red-100)',
      color: 'var(--red-600)'
    } : {
      background: 'var(--red-500)',
      color: '#fff'
    },
    neutral: soft ? {
      background: 'var(--slate-100)',
      color: 'var(--slate-700)'
    } : {
      background: 'var(--slate-700)',
      color: '#fff'
    },
    dark: {
      background: 'var(--ink-900)',
      color: '#fff'
    },
    success: soft ? {
      background: '#DCFCE7',
      color: '#15803D'
    } : {
      background: 'var(--green-500)',
      color: '#fff'
    },
    amber: {
      background: 'var(--amber-400)',
      color: '#3a2a00'
    }
  };
  const t = tones[tone] || tones.brand;
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 14px',
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--fs-xs)',
      fontWeight: 'var(--fw-bold)',
      textTransform: 'uppercase',
      letterSpacing: 'var(--ls-wider)',
      lineHeight: 1,
      borderRadius: 'var(--radius-full)',
      whiteSpace: 'nowrap',
      ...t,
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * NetMaster Button — the brand's primary action element.
 * Solid red primary with optional glow; light secondary; ghost; and a
 * dark/chrome variant for the top bar. Square-ish radius per brand.
 */
function Button({
  children,
  variant = 'primary',
  size = 'md',
  uppercase = false,
  glow = false,
  icon = null,
  iconRight = null,
  disabled = false,
  onClick,
  type = 'button',
  style = {},
  ...rest
}) {
  const sizes = {
    sm: {
      padding: '8px 14px',
      fontSize: 'var(--fs-xs)',
      gap: '6px',
      radius: 'var(--radius-xs)'
    },
    md: {
      padding: '12px 22px',
      fontSize: 'var(--fs-sm)',
      gap: '8px',
      radius: 'var(--radius-md)'
    },
    lg: {
      padding: '16px 28px',
      fontSize: 'var(--fs-body)',
      gap: '10px',
      radius: 'var(--radius-md)'
    }
  };
  const s = sizes[size] || sizes.md;
  const variants = {
    primary: {
      background: 'var(--action-primary)',
      color: 'var(--text-on-brand)',
      border: '1px solid transparent',
      boxShadow: glow ? 'var(--shadow-brand)' : 'none'
    },
    secondary: {
      background: 'var(--action-secondary)',
      color: 'var(--slate-900)',
      border: '1px solid transparent'
    },
    outline: {
      background: 'transparent',
      color: 'var(--red-500)',
      border: '1px solid var(--red-500)'
    },
    ghost: {
      background: 'transparent',
      color: 'var(--slate-700)',
      border: '1px solid transparent'
    },
    dark: {
      background: 'var(--ink-800)',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.12)'
    }
  };
  const v = variants[variant] || variants.primary;
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    disabled: disabled,
    onClick: onClick,
    className: "nm-btn",
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: s.gap,
      padding: s.padding,
      fontFamily: 'var(--font-sans)',
      fontWeight: 'var(--fw-bold)',
      fontSize: s.fontSize,
      lineHeight: 1,
      textTransform: uppercase ? 'uppercase' : 'none',
      letterSpacing: uppercase ? 'var(--ls-wide)' : '0',
      borderRadius: s.radius,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      transition: 'background var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out), transform var(--dur-fast) var(--ease-out)',
      whiteSpace: 'nowrap',
      ...v,
      ...style
    },
    onMouseDown: e => {
      if (!disabled) e.currentTarget.style.transform = 'scale(0.97)';
    },
    onMouseUp: e => {
      e.currentTarget.style.transform = 'scale(1)';
    },
    onMouseLeave: e => {
      e.currentTarget.style.transform = 'scale(1)';
      if (variant === 'primary' && !disabled) {
        e.currentTarget.style.background = 'var(--action-primary)';
        e.currentTarget.style.boxShadow = glow ? 'var(--shadow-brand)' : 'none';
      }
      if (variant === 'secondary' && !disabled) e.currentTarget.style.background = 'var(--action-secondary)';
    },
    onMouseEnter: e => {
      if (disabled) return;
      if (variant === 'primary') {
        e.currentTarget.style.background = 'var(--action-primary-hover)';
        if (glow) e.currentTarget.style.boxShadow = 'var(--shadow-brand-lg)';
      }
      if (variant === 'secondary') e.currentTarget.style.background = 'var(--action-secondary-hover)';
    }
  }, rest), icon, children, iconRight);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * NetMaster Card — white surface, hairline border, soft hairline shadow,
 * 12px radius. `featured` swaps the border for brand red and lifts. `tone`
 * supports sunken (slate-50) and dark surfaces.
 */
function Card({
  children,
  featured = false,
  tone = 'default',
  hover = false,
  padding = 32,
  style = {},
  ...rest
}) {
  const tones = {
    default: {
      background: 'var(--surface-card)',
      border: '1px solid var(--border-subtle)'
    },
    sunken: {
      background: 'var(--slate-50)',
      border: '1px solid var(--border-subtle)'
    },
    muted: {
      background: 'var(--slate-100)',
      border: '1px solid transparent'
    },
    dark: {
      background: 'var(--ink-900)',
      border: '1px solid rgba(255,255,255,0.08)'
    }
  };
  const t = tones[tone] || tones.default;
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      position: 'relative',
      borderRadius: 'var(--radius-lg)',
      padding: typeof padding === 'number' ? `${padding}px` : padding,
      boxShadow: featured ? 'var(--shadow-md)' : 'var(--shadow-card)',
      transition: 'box-shadow var(--dur) var(--ease-out), transform var(--dur) var(--ease-out)',
      ...t,
      ...(featured ? {
        border: '2px solid var(--red-500)'
      } : {}),
      ...style
    },
    onMouseEnter: e => {
      if (!hover) return;
      e.currentTarget.style.boxShadow = 'var(--shadow-lg)';
      e.currentTarget.style.transform = 'translateY(-4px)';
    },
    onMouseLeave: e => {
      if (!hover) return;
      e.currentTarget.style.boxShadow = featured ? 'var(--shadow-md)' : 'var(--shadow-card)';
      e.currentTarget.style.transform = 'translateY(0)';
    }
  }, rest), children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/IconTile.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * NetMaster IconTile — rounded square with a soft red fill holding a red
 * line icon. The signature "feature" motif. Tones available for accents.
 */
function IconTile({
  children,
  size = 64,
  tone = 'brand',
  style = {},
  ...rest
}) {
  const tones = {
    brand: {
      background: 'var(--red-100)',
      color: 'var(--red-500)'
    },
    slate: {
      background: 'var(--slate-100)',
      color: 'var(--slate-700)'
    },
    amber: {
      background: '#FDEFCF',
      color: '#B97D08'
    },
    green: {
      background: '#DCFCE7',
      color: '#15803D'
    },
    dark: {
      background: 'var(--ink-900)',
      color: '#fff'
    }
  };
  const t = tones[tone] || tones.brand;
  const iconSize = Math.round(size * 0.45);
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: 'var(--radius-xl)',
      flexShrink: 0,
      ...t,
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      width: iconSize,
      height: iconSize,
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, children));
}
Object.assign(__ds_scope, { IconTile });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconTile.jsx", error: String((e && e.message) || e) }); }

// components/core/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * NetMaster Input — labelled text field with a soft slate border that
 * focuses to brand red. Optional leading icon. Matches the newsletter /
 * contact form fields.
 */
function Input({
  label,
  type = 'text',
  placeholder,
  value,
  onChange,
  icon = null,
  invalid = false,
  disabled = false,
  id,
  style = {},
  ...rest
}) {
  const [focused, setFocused] = React.useState(false);
  const borderColor = invalid ? 'var(--red-500)' : focused ? 'var(--red-500)' : 'var(--border-default)';
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      fontFamily: 'var(--font-sans)'
    }
  }, label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-sm)',
      fontWeight: 'var(--fw-semibold)',
      color: 'var(--slate-700)'
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      background: 'var(--white)',
      border: `1.5px solid ${borderColor}`,
      borderRadius: 'var(--radius-sm)',
      padding: '0 14px',
      height: '48px',
      transition: 'border-color var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out)',
      boxShadow: focused ? `0 0 0 3px var(--focus-ring)` : 'none',
      opacity: disabled ? 0.6 : 1,
      ...style
    }
  }, icon && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      color: 'var(--slate-400)'
    }
  }, icon), /*#__PURE__*/React.createElement("input", _extends({
    id: id,
    type: type,
    placeholder: placeholder,
    value: value,
    onChange: onChange,
    disabled: disabled,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    style: {
      flex: 1,
      border: 'none',
      outline: 'none',
      background: 'transparent',
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--fs-body)',
      color: 'var(--slate-900)',
      height: '100%'
    }
  }, rest))));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Input.jsx", error: String((e && e.message) || e) }); }

// components/marketing/FAQItem.jsx
try { (() => {
const Chevron = ({
  open
}) => /*#__PURE__*/React.createElement("svg", {
  width: "20",
  height: "20",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2.5",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  style: {
    flexShrink: 0,
    transition: 'transform var(--dur) var(--ease-out)',
    transform: open ? 'rotate(180deg)' : 'rotate(0deg)'
  }
}, /*#__PURE__*/React.createElement("path", {
  d: "m6 9 6 6 6-6"
}));

/**
 * NetMaster FAQItem — an accordion row. Collapsed: white card, bold slate
 * question, chevron. Expanded: the header turns near-black with white text
 * and the slate answer reveals below.
 */
function FAQItem({
  question,
  answer,
  defaultOpen = false,
  style = {}
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--white)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      boxShadow: open ? 'var(--shadow-sm)' : 'none',
      transition: 'box-shadow var(--dur) var(--ease-out)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpen(o => !o),
    style: {
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '16px',
      padding: '20px 24px',
      background: open ? 'var(--ink-900)' : 'transparent',
      color: open ? '#fff' : 'var(--slate-800)',
      border: 'none',
      cursor: 'pointer',
      textAlign: 'left',
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--fs-lg)',
      fontWeight: 'var(--fw-bold)',
      transition: 'background var(--dur) var(--ease-out), color var(--dur) var(--ease-out)'
    }
  }, /*#__PURE__*/React.createElement("span", null, question), /*#__PURE__*/React.createElement(Chevron, {
    open: open
  })), open && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '20px 24px 24px',
      fontSize: 'var(--fs-body)',
      lineHeight: 'var(--lh-relaxed)',
      color: 'var(--slate-500)'
    }
  }, answer));
}
Object.assign(__ds_scope, { FAQItem });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/marketing/FAQItem.jsx", error: String((e && e.message) || e) }); }

// components/marketing/FeatureCard.jsx
try { (() => {
/**
 * NetMaster FeatureCard — an icon tile above a bold title and a slate
 * description. Centered (the Feature-Icons motif) or left-aligned inside a
 * bordered card.
 */
function FeatureCard({
  icon,
  title,
  description,
  tone = 'brand',
  align = 'center',
  boxed = false,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: align === 'center' ? 'center' : 'flex-start',
      textAlign: align,
      gap: '16px',
      padding: boxed ? '32px' : '0',
      background: boxed ? 'var(--surface-card)' : 'transparent',
      border: boxed ? '1px solid var(--border-subtle)' : 'none',
      borderRadius: boxed ? 'var(--radius-lg)' : '0',
      boxShadow: boxed ? 'var(--shadow-card)' : 'none',
      ...style
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.IconTile, {
    tone: tone,
    size: 64
  }, icon), /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: 0,
      fontSize: 'var(--fs-h3)',
      fontWeight: 'var(--fw-bold)',
      color: 'var(--slate-900)',
      lineHeight: 'var(--lh-snug)'
    }
  }, title), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 'var(--fs-body)',
      lineHeight: 'var(--lh-relaxed)',
      color: 'var(--slate-500)',
      maxWidth: '320px'
    }
  }, description));
}
Object.assign(__ds_scope, { FeatureCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/marketing/FeatureCard.jsx", error: String((e && e.message) || e) }); }

// components/marketing/PricingCard.jsx
try { (() => {
const CheckCircle = () => /*#__PURE__*/React.createElement("svg", {
  width: "20",
  height: "20",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  style: {
    flexShrink: 0
  }
}, /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "12",
  r: "10"
}), /*#__PURE__*/React.createElement("path", {
  d: "m9 12 2 2 4-4"
}));

/**
 * NetMaster PricingCard — a hosting/service plan. Name + description, big
 * red price with /period unit, a CTA, and a check-list of features. The
 * `featured` plan gets a red border, "MAIS POPULAR" flag and a solid CTA.
 */
function PricingCard({
  name,
  description,
  price,
  period = '/mês',
  features = [],
  ctaLabel = 'Começar Agora',
  onCta,
  featured = false,
  badgeLabel = 'Mais Popular',
  style = {}
}) {
  return /*#__PURE__*/React.createElement(__ds_scope.Card, {
    featured: featured,
    tone: featured ? 'default' : 'sunken',
    padding: 36,
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '24px',
      minWidth: '280px',
      ...style
    }
  }, featured && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '-14px',
      left: '50%',
      transform: 'translateX(-50%)'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    tone: "brand"
  }, badgeLabel)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px'
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: 0,
      fontSize: 'var(--fs-h3)',
      fontWeight: 'var(--fw-bold)',
      color: 'var(--slate-900)'
    }
  }, name), description && /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 'var(--fs-body)',
      color: 'var(--slate-500)'
    }
  }, description)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: '4px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: 'var(--fs-display-md)',
      fontWeight: 'var(--fw-black)',
      color: 'var(--red-500)',
      lineHeight: 1
    }
  }, price), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-lg)',
      fontWeight: 'var(--fw-medium)',
      color: 'var(--slate-500)'
    }
  }, period)), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: featured ? 'primary' : 'secondary',
    glow: featured,
    size: "lg",
    onClick: onCta,
    style: {
      width: '100%'
    }
  }, ctaLabel), /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: 'none',
      margin: 0,
      padding: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: '14px'
    }
  }, features.map((f, i) => {
    const text = typeof f === 'string' ? f : f.text;
    const strong = typeof f === 'object' && f.strong;
    return /*#__PURE__*/React.createElement("li", {
      key: i,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        color: 'var(--red-500)'
      }
    }, /*#__PURE__*/React.createElement(CheckCircle, null), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--fs-body)',
        fontWeight: strong ? 'var(--fw-bold)' : 'var(--fw-regular)',
        color: 'var(--slate-700)'
      }
    }, text));
  })));
}
Object.assign(__ds_scope, { PricingCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/marketing/PricingCard.jsx", error: String((e && e.message) || e) }); }

// components/marketing/SectionHeader.jsx
try { (() => {
/**
 * NetMaster SectionHeader — the recurring section intro: a small red
 * uppercase eyebrow, a big uppercase/title display heading, and an optional
 * slate subtitle. Centered by default; pass align="left" for left rail.
 */
function SectionHeader({
  eyebrow,
  title,
  subtitle,
  align = 'center',
  onDark = false,
  display = true,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      alignItems: align === 'center' ? 'center' : 'flex-start',
      textAlign: align,
      maxWidth: align === 'center' ? '720px' : 'none',
      margin: align === 'center' ? '0 auto' : '0',
      ...style
    }
  }, eyebrow && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-xs)',
      fontWeight: 'var(--fw-bold)',
      textTransform: 'uppercase',
      letterSpacing: 'var(--ls-wider)',
      color: 'var(--red-500)'
    }
  }, eyebrow), /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: 0,
      fontFamily: 'var(--font-display)',
      fontSize: display ? 'var(--fs-display-md)' : 'var(--fs-h1)',
      fontWeight: display ? 'var(--fw-extrabold)' : 'var(--fw-bold)',
      textTransform: display ? 'uppercase' : 'none',
      letterSpacing: 'var(--ls-display)',
      lineHeight: 'var(--lh-snug)',
      color: onDark ? '#fff' : 'var(--slate-900)'
    }
  }, title), subtitle && /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 'var(--fs-lg)',
      fontWeight: 'var(--fw-regular)',
      lineHeight: 'var(--lh-relaxed)',
      color: onDark ? 'var(--slate-400)' : 'var(--slate-500)',
      maxWidth: '620px'
    }
  }, subtitle));
}
Object.assign(__ds_scope, { SectionHeader });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/marketing/SectionHeader.jsx", error: String((e && e.message) || e) }); }

// components/marketing/TestimonialCard.jsx
try { (() => {
const Quote = ({
  color
}) => /*#__PURE__*/React.createElement("svg", {
  width: "40",
  height: "32",
  viewBox: "0 0 40 32",
  fill: color,
  "aria-hidden": "true"
}, /*#__PURE__*/React.createElement("path", {
  d: "M0 32V18C0 8 6 1.5 16 0l1.5 5C11 6.5 8 10 8 14h8v18H0Zm22 0V18C22 8 28 1.5 38 0l1.5 5C33 6.5 30 10 30 14h8v18H22Z"
}));
const Stars = ({
  count = 5
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: '2px'
  }
}, Array.from({
  length: count
}).map((_, i) => /*#__PURE__*/React.createElement("svg", {
  key: i,
  width: "16",
  height: "16",
  viewBox: "0 0 24 24",
  fill: "var(--amber-400)"
}, /*#__PURE__*/React.createElement("path", {
  d: "M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.8 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"
}))));

/**
 * NetMaster TestimonialCard — a customer quote with author. `onDark` matches
 * the near-black "Dizem sobre nós" section; light card variant otherwise.
 */
function TestimonialCard({
  quote,
  author,
  role,
  rating = 5,
  onDark = false,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '20px',
      padding: onDark ? '0' : '32px',
      background: onDark ? 'transparent' : 'var(--surface-card)',
      border: onDark ? 'none' : '1px solid var(--border-subtle)',
      borderRadius: onDark ? '0' : 'var(--radius-lg)',
      boxShadow: onDark ? 'none' : 'var(--shadow-card)',
      maxWidth: '640px',
      ...style
    }
  }, /*#__PURE__*/React.createElement(Quote, {
    color: onDark ? 'rgba(255,255,255,0.9)' : 'var(--red-500)'
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: onDark ? 'var(--fs-h4)' : 'var(--fs-lg)',
      fontWeight: 'var(--fw-regular)',
      lineHeight: 'var(--lh-relaxed)',
      color: onDark ? 'var(--slate-300)' : 'var(--slate-600)'
    }
  }, "\u201C", quote, "\u201D"), rating > 0 && /*#__PURE__*/React.createElement(Stars, {
    count: rating
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-sm)',
      fontWeight: 'var(--fw-bold)',
      textTransform: 'uppercase',
      letterSpacing: 'var(--ls-wide)',
      color: onDark ? '#fff' : 'var(--slate-900)'
    }
  }, author), role && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-sm)',
      color: onDark ? 'var(--slate-400)' : 'var(--slate-500)'
    }
  }, role)));
}
Object.assign(__ds_scope, { TestimonialCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/marketing/TestimonialCard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Site.jsx
try { (() => {
/* NetMaster website — composition + interactive state. */

function Toast({
  message,
  onDone
}) {
  React.useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [message]);
  if (!message) return null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      bottom: 28,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 200,
      background: 'var(--ink-900)',
      color: '#fff',
      padding: '14px 22px',
      borderRadius: 'var(--radius-md)',
      boxShadow: 'var(--shadow-lg)',
      display: 'flex',
      gap: 10,
      alignItems: 'center',
      fontSize: 14,
      fontWeight: 600
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      width: 20,
      height: 20,
      borderRadius: 999,
      background: 'var(--red-500)',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 13,
    color: "#fff"
  })), message);
}
function Site() {
  const [cart, setCart] = React.useState(1);
  const [selected, setSelected] = React.useState(null);
  const [toast, setToast] = React.useState('');
  React.useEffect(() => {
    if (window.lucide) lucide.createIcons();
  });
  const selectPlan = name => {
    setSelected(name);
    setCart(c => c + 1);
    setToast(`Plano ${name} adicionado ao carrinho`);
  };
  const reqProposal = () => setToast('Pedido de proposta enviado — entraremos em contacto!');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--paper)'
    }
  }, /*#__PURE__*/React.createElement(TopBar, null), /*#__PURE__*/React.createElement(Navbar, {
    cartCount: cart,
    onNav: () => {},
    active: "ALOJAMENTO"
  }), /*#__PURE__*/React.createElement(Hero, {
    onCta: reqProposal
  }), /*#__PURE__*/React.createElement(Features, null), /*#__PURE__*/React.createElement(Pricing, {
    onSelect: selectPlan,
    selected: selected
  }), /*#__PURE__*/React.createElement(Portfolio, null), /*#__PURE__*/React.createElement(Testimonials, null), /*#__PURE__*/React.createElement(FAQ, null), /*#__PURE__*/React.createElement(Newsletter, null), /*#__PURE__*/React.createElement(Footer, null), /*#__PURE__*/React.createElement(Toast, {
    message: toast,
    onDone: () => setToast('')
  }));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(Site, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Site.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/chrome.jsx
try { (() => {
/* NetMaster website — chrome: TopBar, Navbar, Footer.
   Exposes components on window for the other babel scripts. */

const NAV_LINKS = ['SOBRE NÓS', 'MARKETING DIGITAL', 'ALOJAMENTO', 'DESENVOLVIMENTO', 'PORTFÓLIO', 'CONTACTOS'];
const SOCIALS = ['facebook', 'instagram', 'twitter', 'linkedin', 'message-circle'];
function Icon({
  name,
  size = 18,
  color,
  strokeWidth = 2,
  style
}) {
  return /*#__PURE__*/React.createElement("i", {
    "data-lucide": name,
    style: {
      display: 'inline-flex',
      width: size,
      height: size,
      color,
      strokeWidth,
      ...style
    }
  });
}
function TopBar() {
  const {
    Button
  } = window.NetmasterDesignSystem_afcc6f;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--ink-800)',
      color: '#fff',
      borderBottom: '1px solid rgba(255,255,255,0.1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      height: 53,
      padding: '0 var(--container-pad)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 18,
      alignItems: 'center'
    }
  }, SOCIALS.map(s => /*#__PURE__*/React.createElement("a", {
    key: s,
    href: "#",
    style: {
      color: 'var(--red-500)',
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: s,
    size: 17
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 24,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      fontSize: 12,
      fontWeight: 500,
      letterSpacing: '.03em'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "phone",
    size: 13,
    color: "var(--red-500)"
  }), " +351 91 706 10 69"), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      fontSize: 12,
      fontWeight: 500,
      letterSpacing: '.03em',
      borderLeft: '1px solid rgba(255,255,255,0.2)',
      paddingLeft: 24
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "mail",
    size: 13,
    color: "var(--red-500)"
  }), " GERAL@NETMASTER.PT"), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "sm",
    uppercase: true,
    icon: /*#__PURE__*/React.createElement(Icon, {
      name: "send",
      size: 13,
      color: "#fff"
    })
  }, "Pe\xE7a a sua proposta"))));
}
function Navbar({
  cartCount = 1,
  onNav,
  active
}) {
  return /*#__PURE__*/React.createElement("nav", {
    style: {
      background: '#fff',
      boxShadow: 'var(--shadow-xs)',
      position: 'sticky',
      top: 0,
      zIndex: 50
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      height: 80,
      padding: '0 var(--container-pad)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNav && onNav('home');
    },
    style: {
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo-netmaster.png",
    alt: "NetMaster",
    style: {
      height: 40
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 28,
      alignItems: 'center'
    }
  }, NAV_LINKS.map(l => /*#__PURE__*/React.createElement("a", {
    key: l,
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNav && onNav(l);
    },
    style: {
      fontSize: 14,
      fontWeight: 600,
      letterSpacing: '.02em',
      color: active === l ? 'var(--red-500)' : 'var(--slate-800)',
      transition: 'color var(--dur)'
    },
    onMouseEnter: e => e.currentTarget.style.color = 'var(--red-500)',
    onMouseLeave: e => e.currentTarget.style.color = active === l ? 'var(--red-500)' : 'var(--slate-800)'
  }, l))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 22,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      color: 'var(--red-500)',
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "user",
    size: 20
  })), /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      color: 'var(--red-500)',
      display: 'flex',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "shopping-cart",
    size: 20
  }), cartCount > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: -6,
      right: -7,
      minWidth: 16,
      height: 16,
      padding: '0 4px',
      background: 'var(--red-500)',
      color: '#fff',
      borderRadius: 999,
      fontSize: 10,
      fontWeight: 700,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, cartCount)))));
}
function Footer() {
  const cols = [{
    title: 'Services',
    items: ['Cloud Infrastructure', 'Network Security', 'Managed IT Services', 'Digital Strategy', 'Data Analytics']
  }, {
    title: 'Suporte',
    items: ['Help Center', 'Contactos', 'Knowledgebase', 'FAQ', 'Status']
  }, {
    title: 'Empresa',
    items: ['Sobre Nós', 'Portfólio', 'Carreiras', 'Blog', 'Parceiros']
  }];
  return /*#__PURE__*/React.createElement("footer", {
    style: {
      background: 'var(--ink-800)',
      color: '#fff'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '72px var(--container-pad) 40px',
      display: 'grid',
      gridTemplateColumns: '1.4fr 1fr 1fr 1fr',
      gap: 48
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo-netmaster-white.png",
    alt: "NetMaster",
    style: {
      height: 84,
      marginLeft: -6
    }
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      marginTop: 16,
      fontSize: 14,
      lineHeight: 1.7,
      color: 'var(--slate-400)',
      maxWidth: 280
    }
  }, "Parceiro digital para alojamento, desenvolvimento e marketing. Power to do more."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14,
      marginTop: 20
    }
  }, SOCIALS.map(s => /*#__PURE__*/React.createElement("a", {
    key: s,
    href: "#",
    style: {
      color: '#fff',
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: s,
    size: 18
  }))))), cols.map(c => /*#__PURE__*/React.createElement("div", {
    key: c.title
  }, /*#__PURE__*/React.createElement("h4", {
    style: {
      margin: '0 0 18px',
      fontSize: 22,
      fontWeight: 800
    }
  }, c.title), /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: 'none',
      margin: 0,
      padding: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, c.items.map(it => /*#__PURE__*/React.createElement("li", {
    key: it
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontSize: 15,
      color: 'var(--slate-300)'
    },
    onMouseEnter: e => e.currentTarget.style.color = '#fff',
    onMouseLeave: e => e.currentTarget.style.color = 'var(--slate-300)'
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 18,
      height: 18,
      borderRadius: 999,
      background: 'var(--red-500)',
      color: '#fff',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "chevron-right",
    size: 12,
    color: "#fff"
  })), it))))))), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid rgba(255,255,255,0.1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '22px var(--container-pad)',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      fontSize: 13,
      color: 'var(--slate-400)'
    }
  }, /*#__PURE__*/React.createElement("span", null, "\xA9 2026 NetMaster. Todos os direitos reservados."), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      gap: 24
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      color: 'var(--slate-400)'
    }
  }, "Termos"), /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      color: 'var(--slate-400)'
    }
  }, "Privacidade"), /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      color: 'var(--slate-400)'
    }
  }, "Cookies")))));
}
Object.assign(window, {
  Icon,
  TopBar,
  Navbar,
  Footer
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/chrome.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/sections.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/* NetMaster website — page sections. Composes the design-system components. */

function Section({
  children,
  bg = 'var(--paper)',
  pad = '96px',
  id
}) {
  return /*#__PURE__*/React.createElement("section", {
    id: id,
    style: {
      background: bg
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: `${pad} var(--container-pad)`
    }
  }, children));
}
function Hero({
  onCta
}) {
  const {
    Button
  } = window.NetmasterDesignSystem_afcc6f;
  return /*#__PURE__*/React.createElement("header", {
    style: {
      position: 'relative',
      minHeight: 540,
      display: 'flex',
      alignItems: 'center',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/hero-marketing.png",
    alt: "",
    style: {
      position: 'absolute',
      inset: 0,
      width: '100%',
      height: '100%',
      objectFit: 'cover'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: 'linear-gradient(90deg, rgba(13,40,48,0.92) 0%, rgba(13,40,48,0.72) 45%, rgba(13,40,48,0.45) 100%)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '0 var(--container-pad)',
      width: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 640
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '.16em',
      color: 'var(--red-400)'
    }
  }, "Ag\xEAncia Digital"), /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: '16px 0 0',
      fontFamily: 'var(--font-display)',
      fontWeight: 900,
      textTransform: 'uppercase',
      fontSize: 60,
      lineHeight: 1.02,
      letterSpacing: '-0.01em',
      color: '#fff'
    }
  }, "Social Media", /*#__PURE__*/React.createElement("br", null), "Marketing"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '22px 0 0',
      fontSize: 18,
      lineHeight: 1.6,
      color: 'rgba(255,255,255,0.82)',
      maxWidth: 520
    }
  }, "Estrat\xE9gias de conte\xFAdo e gest\xE3o de redes que transformam seguidores em clientes. Resultados mensur\xE1veis, do primeiro dia."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14,
      marginTop: 32
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    glow: true,
    uppercase: true,
    icon: /*#__PURE__*/React.createElement(Icon, {
      name: "send",
      size: 16,
      color: "#fff"
    }),
    onClick: onCta
  }, "Pe\xE7a a sua proposta"), /*#__PURE__*/React.createElement(Button, {
    variant: "dark",
    size: "lg",
    uppercase: true
  }, "Ver portf\xF3lio")))));
}
const FEATURES = [{
  icon: 'rocket',
  tone: 'brand',
  title: 'Ativação Instantânea',
  desc: 'Seu servidor fica online em menos de 60 segundos após a confirmação do pagamento.'
}, {
  icon: 'shield-check',
  tone: 'green',
  title: 'Proteção DDoS Inclusa',
  desc: 'Camada de proteção profissional para manter a sua infraestrutura segura.'
}, {
  icon: 'headphones',
  tone: 'amber',
  title: 'Suporte 24/7',
  desc: 'Equipa técnica disponível a qualquer hora, por chat, email ou telefone.'
}, {
  icon: 'gauge',
  tone: 'slate',
  title: 'Performance NVMe',
  desc: 'Armazenamento de última geração para sites rápidos e responsivos.'
}];
function Features() {
  const {
    SectionHeader,
    FeatureCard
  } = window.NetmasterDesignSystem_afcc6f;
  return /*#__PURE__*/React.createElement(Section, {
    bg: "var(--surface-sunken)"
  }, /*#__PURE__*/React.createElement(SectionHeader, {
    eyebrow: "Porqu\xEA a NetMaster",
    title: "Tudo o que precisa para crescer",
    subtitle: "Infraestrutura robusta, seguran\xE7a inclu\xEDda e suporte de pessoas reais."
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 36,
      marginTop: 56
    }
  }, FEATURES.map(f => /*#__PURE__*/React.createElement(FeatureCard, {
    key: f.title,
    tone: f.tone,
    icon: /*#__PURE__*/React.createElement(Icon, {
      name: f.icon,
      size: 28
    }),
    title: f.title,
    description: f.desc
  }))));
}
const PLANS = [{
  name: 'Essencial',
  description: 'Ideal para blogs e sites pequenos',
  price: '3.99€',
  cta: 'Começar Agora',
  features: ['1 Website', '10GB Espaço NVMe', 'Tráfego Ilimitado', 'Painel Control Web', 'Certificado SSL Grátis']
}, {
  name: 'Profissional',
  description: 'Para negócios em crescimento',
  price: '7.99€',
  cta: 'Selecionar Plano',
  featured: true,
  features: [{
    text: 'Websites Ilimitados',
    strong: true
  }, '50GB Espaço NVMe', 'Tráfego Ilimitado', 'Backups Diários', 'Suporte Prioritário']
}, {
  name: 'Empresa',
  description: 'Performance dedicada e escala',
  price: '19.99€',
  cta: 'Falar com Vendas',
  features: ['Websites Ilimitados', '200GB Espaço NVMe', 'CDN Global Incluída', 'IP Dedicado', 'Gestor de Conta']
}];
function Pricing({
  onSelect,
  selected
}) {
  const {
    SectionHeader,
    PricingCard
  } = window.NetmasterDesignSystem_afcc6f;
  return /*#__PURE__*/React.createElement(Section, {
    bg: "var(--white)",
    id: "planos"
  }, /*#__PURE__*/React.createElement(SectionHeader, {
    eyebrow: "Planos de Alojamento",
    title: "Escolha o plano ideal",
    subtitle: "Escalabilidade total para acompanhar o crescimento do seu neg\xF3cio."
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: 24,
      marginTop: 64,
      alignItems: 'start'
    }
  }, PLANS.map(p => /*#__PURE__*/React.createElement(PricingCard, _extends({
    key: p.name
  }, p, {
    ctaLabel: selected === p.name ? '✓ Selecionado' : p.cta,
    onCta: () => onSelect && onSelect(p.name)
  })))));
}
const PROJECTS = [{
  img: '../../assets/portfolio-1.png',
  tag: 'E-Commerce',
  title: 'Loja Atlântico',
  desc: 'Plataforma de vendas online com gestão integrada.'
}, {
  img: '../../assets/portfolio-2.png',
  tag: 'Branding',
  title: 'Studio Norte',
  desc: 'Identidade visual e website institucional.'
}, {
  img: '../../assets/portfolio-3.png',
  tag: 'Web App',
  title: 'Reserva Já',
  desc: 'Aplicação de reservas para restauração.'
}];
function Portfolio() {
  const {
    SectionHeader,
    Badge
  } = window.NetmasterDesignSystem_afcc6f;
  return /*#__PURE__*/React.createElement(Section, {
    bg: "var(--surface-sunken)",
    id: "portfolio"
  }, /*#__PURE__*/React.createElement(SectionHeader, {
    eyebrow: "Portf\xF3lio",
    title: "Trabalho de que nos orgulhamos",
    subtitle: "Uma sele\xE7\xE3o de projetos recentes entregues \xE0 nossa carteira de clientes."
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: 28,
      marginTop: 56
    }
  }, PROJECTS.map(p => /*#__PURE__*/React.createElement("article", {
    key: p.title,
    style: {
      background: '#fff',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      border: '1px solid var(--border-subtle)',
      boxShadow: 'var(--shadow-card)',
      transition: 'transform var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out)',
      cursor: 'pointer'
    },
    onMouseEnter: e => {
      e.currentTarget.style.transform = 'translateY(-6px)';
      e.currentTarget.style.boxShadow = 'var(--shadow-lg)';
    },
    onMouseLeave: e => {
      e.currentTarget.style.transform = 'translateY(0)';
      e.currentTarget.style.boxShadow = 'var(--shadow-card)';
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 200,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: p.img,
    alt: p.title,
    style: {
      width: '100%',
      height: '100%',
      objectFit: 'cover'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 24
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    tone: "brand",
    soft: true
  }, p.tag), /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: '14px 0 6px',
      fontSize: 20,
      fontWeight: 700,
      color: 'var(--slate-900)'
    }
  }, p.title), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 15,
      lineHeight: 1.6,
      color: 'var(--slate-500)'
    }
  }, p.desc))))));
}
const QUOTES = [{
  quote: 'A NetMaster transformou a nossa presença online. Triplicámos o tráfego orgânico em apenas seis meses.',
  author: 'Marta Silva',
  role: 'CEO · Loja Atlântico'
}, {
  quote: 'Migração sem dores de cabeça e uptime impecável. O suporte responde sempre em minutos.',
  author: 'Rui Costa',
  role: 'CTO · Reserva Já'
}, {
  quote: 'Profissionais sérios. O novo website duplicou as nossas conversões.',
  author: 'Ana Marques',
  role: 'Fundadora · Studio Norte'
}];
function Testimonials() {
  const {
    SectionHeader,
    TestimonialCard
  } = window.NetmasterDesignSystem_afcc6f;
  const [i, setI] = React.useState(0);
  return /*#__PURE__*/React.createElement("section", {
    style: {
      background: 'var(--ink-900)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '96px var(--container-pad)'
    }
  }, /*#__PURE__*/React.createElement(SectionHeader, {
    onDark: true,
    eyebrow: "O que",
    title: "Dizem sobre n\xF3s",
    align: "center"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 48,
      display: 'flex',
      justifyContent: 'center',
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement(TestimonialCard, _extends({
    onDark: true
  }, QUOTES[i], {
    style: {
      alignItems: 'center',
      textAlign: 'center'
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      justifyContent: 'center',
      marginTop: 36
    }
  }, QUOTES.map((_, n) => /*#__PURE__*/React.createElement("button", {
    key: n,
    onClick: () => setI(n),
    "aria-label": `Slide ${n + 1}`,
    style: {
      width: n === i ? 28 : 10,
      height: 10,
      borderRadius: 999,
      border: 'none',
      cursor: 'pointer',
      background: n === i ? 'var(--red-500)' : 'var(--slate-700)',
      transition: 'all var(--dur) var(--ease-out)'
    }
  })))));
}
const FAQS = [{
  q: 'Como funciona o acesso à plataforma?',
  a: 'Recebe as credenciais de acesso por email imediatamente após a confirmação do registo, com painel de controlo completo e tutoriais de arranque.'
}, {
  q: 'Posso migrar o meu site atual sem custos?',
  a: 'Sim. A nossa equipa trata da migração completa do seu site, incluindo bases de dados e emails, sem qualquer custo adicional e sem tempo de indisponibilidade.'
}, {
  q: 'Que tipo de suporte está incluído?',
  a: 'Todos os planos incluem suporte técnico 24/7 por chat, email e telefone, com tempos de resposta prioritários nos planos Profissional e Empresa.'
}, {
  q: 'Existe garantia de devolução?',
  a: 'Oferecemos uma garantia de devolução de 30 dias em todos os planos de alojamento, sem perguntas.'
}];
function FAQ() {
  const {
    SectionHeader,
    FAQItem
  } = window.NetmasterDesignSystem_afcc6f;
  return /*#__PURE__*/React.createElement(Section, {
    bg: "var(--surface-sunken)",
    id: "faq"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '0.8fr 1.2fr',
      gap: 64,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement(SectionHeader, {
    align: "left",
    eyebrow: "Ainda tem quest\xF5es?",
    title: "Quest\xF5es Frequentes",
    subtitle: "Tudo o que precisa de saber. N\xE3o encontra a resposta? Fale connosco."
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, FAQS.map((f, n) => /*#__PURE__*/React.createElement(FAQItem, {
    key: n,
    defaultOpen: n === 0,
    question: f.q,
    answer: f.a
  })))));
}
function Newsletter() {
  const {
    Button,
    Input
  } = window.NetmasterDesignSystem_afcc6f;
  const [sent, setSent] = React.useState(false);
  return /*#__PURE__*/React.createElement("section", {
    style: {
      background: 'var(--amber-400)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '64px var(--container-pad)',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 56,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: 0,
      fontFamily: 'var(--font-display)',
      fontSize: 42,
      fontWeight: 900,
      lineHeight: 1.1,
      color: 'var(--ink-900)'
    }
  }, "Subscreva a nossa Newsletter"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '16px 0 0',
      fontSize: 16,
      lineHeight: 1.6,
      color: 'rgba(18,18,18,0.7)',
      maxWidth: 420
    }
  }, "Fique a par de todas as novidades e atualiza\xE7\xF5es tecnol\xF3gicas da NetMaster.")), /*#__PURE__*/React.createElement("form", {
    onSubmit: e => {
      e.preventDefault();
      setSent(true);
    },
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement(Input, {
    placeholder: "Nome"
  }), /*#__PURE__*/React.createElement(Input, {
    type: "email",
    placeholder: "E-Mail"
  }), /*#__PURE__*/React.createElement(Button, {
    type: "submit",
    variant: "primary",
    size: "lg",
    glow: true,
    style: {
      width: '100%'
    }
  }, sent ? '✓ Subscrito!' : 'Subscrever'))));
}
Object.assign(window, {
  Section,
  Hero,
  Features,
  Pricing,
  Portfolio,
  Testimonials,
  FAQ,
  Newsletter
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/sections.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.IconTile = __ds_scope.IconTile;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.FAQItem = __ds_scope.FAQItem;

__ds_ns.FeatureCard = __ds_scope.FeatureCard;

__ds_ns.PricingCard = __ds_scope.PricingCard;

__ds_ns.SectionHeader = __ds_scope.SectionHeader;

__ds_ns.TestimonialCard = __ds_scope.TestimonialCard;

})();
