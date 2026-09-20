import { describe, expect, it } from 'vitest'
import { parseAdrClaimants } from '../../scripts/fix-shortcut-association.mjs'

// 摘自真实 `lsregister -dump`：自家 beta 副本（动态 UTI）、正式 UTI 声明、
// 别的应用、以及只有 `claim id:` 的类型记录混在一起。
const SEP = '-'.repeat(80)

const DUMP = [
  `${SEP}`,
  'bundle id:                  AndDrive Beta (0x18004)',
  'container:                  / (0x4)',
  'path:                       /Users/xh/code/anddrive/release/beta/1/mac-arm64/AndDrive Beta.app (0x1cf98)',
  'identifier:                 com.anddrive.next.beta',
  'claimed UTIs:               dyn.ah62d4rv4ge80c3dw (.adr)',
  'claimed schemes:            anddrive:',
  `${SEP}`,
  'claim id:                   AndDrive Mirror (0xa450)',
  'rank:                       Default',
  'bundle:                     AndDrive Beta (0x18004)',
  'bindings:                   .adr',
  `${SEP}`,
  'bundle id:                  AndDrive (0x19001)',
  'path:                       /Applications/AndDrive.app',
  'identifier:                 com.anddrive.next',
  'claimed UTIs:               com.anddrive.mirror-shortcut (.adr), public.data',
  `${SEP}`,
  'bundle id:                  AndroMeld (0x200)',
  'path:                       /Applications/AndroMeld.app',
  'identifier:                 com.catchingnow.andship',
  'claimed UTIs:               com.catchingnow.andfiles.app-shortcut (.adrx)',
  `${SEP}`,
  'bundle id:                  TextEdit (0x300)',
  'path:                       /System/Applications/TextEdit.app',
  'identifier:                 com.apple.TextEdit',
  'claimed UTIs:               public.plain-text (.txt)',
  SEP,
].join('\n')

describe('.adr 注册清理的 dump 解析', () => {
  it('只挑出自家且确实声称了 .adr 的 app 副本', () => {
    expect(parseAdrClaimants(DUMP)).toEqual([
      {
        path: '/Users/xh/code/anddrive/release/beta/1/mac-arm64/AndDrive Beta.app',
        identifier: 'com.anddrive.next.beta',
      },
      { path: '/Applications/AndDrive.app', identifier: 'com.anddrive.next' },
    ])
  })

  it('按正式 UTI 标识也能认出声明（不依赖动态 UTI）', () => {
    const dump = [
      SEP,
      'bundle id:                  AndDrive (0x1)',
      'path:                       /Applications/AndDrive.app (0x2)',
      'identifier:                 com.anddrive.next',
      `claimed UTIs:               ${'com.anddrive.mirror-shortcut'} (com.anddrive.mirror-shortcut)`,
      SEP,
    ].join('\n')
    expect(parseAdrClaimants(dump).map((item) => item.path)).toEqual(['/Applications/AndDrive.app'])
  })

  it('没有 bundle 路径的记录不会参与清理', () => {
    expect(
      parseAdrClaimants(
        [
          SEP,
          'bundle id: Orphan (0x1)',
          'identifier: com.anddrive.next',
          'claimed UTIs: x (.adr)',
          SEP,
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('空 dump 返回空列表', () => {
    expect(parseAdrClaimants('')).toEqual([])
  })
})
