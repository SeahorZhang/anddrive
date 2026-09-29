import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'

import { useAppSearch } from '../../src/composables/useAppSearch.js'

// 懒加载的全部意义：首屏不付那 280KB。代价是「敲第一个字母」到「拼音生效」之间有一个
// 动态 import 的间隙 —— 这里验的就是这个间隙结束后，列表会自己重算，不需要用户再敲一下。

const APPS = [{ label: '抖音', packageName: 'com.ss.android.ugc.aweme' }]

describe('useAppSearch', () => {
  it('拼音表还没到位时按名字/包名照常搜；加载完成后首字母自动生效', async () => {
    const query = ref('')
    const filtered = useAppSearch(() => APPS, query)

    query.value = '抖音'
    expect(filtered.value).toHaveLength(1)

    query.value = 'dy'
    expect(filtered.value).toHaveLength(0) // 表还在路上

    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(filtered.value).toHaveLength(1) // 加载完自己重算，不用用户再敲
  })
})
