# Home icon assets

`public/icons/` contains vector elements extracted unchanged from
[`home-export.svg`](./home-export.svg). Each asset keeps the original document
coordinates in its `viewBox`, so it crops to the matching Figma icon without
using the exported screen image.

| Asset | Use in the app | Source elements in `home-export.svg` |
| --- | --- | --- |
| `/icons/home.svg` | Bottom navigation: ホーム | direct path 17 |
| `/icons/history.svg` | Bottom navigation: 履歴 | direct paths 19–24 |
| `/icons/add.svg` | Bottom navigation: 新規登録 action mark | direct path 35; render it on the green circular button supplied by the UI |
| `/icons/analytics.svg` | Bottom navigation: 分析 | direct path 26 |
| `/icons/settings.svg` | Bottom navigation: 設定 | direct paths 28–29 |
| `/icons/bell.svg` | Header notification button | direct path 10; render it in the UI's white circular button |
| `/icons/avatar.svg` | Header account button | direct path 13; render it in the UI's pale circular button |
| `/icons/category-food.svg` | Category: 食費 | original `path-64` mask and its following path |
| `/icons/category-daily.svg` | Category: 日用品 | direct path 73 |
| `/icons/category-transit.svg` | Category: 交通費 | direct path 77 |
| `/icons/category-utility.svg` | Category: 光熱費 | direct path 83 |
| `/icons/category-subscription.svg` | Category: サブスク | direct paths 85–87 |
| `/icons/category-other.svg` | Category: その他 | direct path 91 |

The source home frame has no hobby category bubble. No `/icons/category-hobby.svg`
was created to avoid reusing an unrelated glyph. The six extracted category
assets contain only the rendered glyph path(s), with no category label, amount,
or decorative bubble shape.
