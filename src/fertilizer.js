/**
 * 化肥自动化模块
 *
 * 功能：
 *   1. 用点券自动购买化肥礼包（100003 化肥礼包、100004 有机化肥礼包）（需配置开启）
 *   2. 自动开启背包中的化肥礼包（100003 化肥礼包、100004 有机化肥礼包）
 *   3. 背包中化肥道具数量超过目标阈值时，自动使用多余部分（填充化肥容器）
 *
 * 配置（通过环境变量）：
 *   AUTO_USE_FERTILIZER=true            - 开启开礼包/使用道具功能（默认开启）
 *   FERTILIZER_TARGET_COUNT=0           - 化肥道具保留目标数量（默认 0）
 *   FERTILIZER_PACK_DAILY_LIMIT=0       - 每日最多开启礼包数（0 不限，默认 0）
 *   AUTO_BUY_FERTILIZER_PACK=true       - 开启点券购买礼包功能（默认开启）
 *   FERTILIZER_PACK_BUY_DAILY_LIMIT=0   - 每日最多购买礼包次数（0 不限，默认 0）
 *   FERTILIZER_PACK_BUY_AMOUNT=1        - 每次购买数量（默认 1）
 *   FERTILIZER_PACK_TARGET_STOCK=0      - 背包礼包目标库存，达到后停止购买（0 不限，默认 0）
 */

const { CONFIG } = require('./config');
const { types } = require('./proto');
const { sendMsgAsync } = require('./network');
const { toLong, toNum, log, logWarn, sleep } = require('./utils');
const { getBag, getBagItems } = require('./warehouse');

// ============ 常量 ============

/** 回退模式下每次请求间的节流延迟（毫秒） */
const THROTTLE_DELAY_MS = 300;
/** 登录后首次执行化肥任务的延迟（毫秒） */
const INITIAL_DELAY_MS = 15000;
/** 定期执行化肥任务的默认间隔（毫秒） */
const DEFAULT_FERTILIZER_INTERVAL_MS = 3600000; // 1小时
/** 两次购买尝试之间的最小间隔（毫秒），避免高频请求 */
const BUY_COOLDOWN_MS = 10 * 60 * 1000; // 10分钟
/** 按条目批量使用时每条目之间的节流延迟（毫秒） */
const BATCH_USE_SLEEP_MS = 100;

// ============ 化肥相关物品 ID ============

/** 点券物品 ID */
const COUPON_ITEM_ID = 1002;

/** 化肥礼包 ID 集合 (type=11, can_use=1) */
const FERTILIZER_PACK_IDS = new Set([
    100003, // 化肥礼包
    100004, // 有机化肥礼包
]);

/**
 * 化肥道具 ID 集合 (type=7, interaction_type='fertilizer'/'fertilizerpro')
 * 使用后填充对应化肥容器的时间
 */
const FERTILIZER_ITEM_IDS = new Set([
    80001, // 化肥(1小时)
    80002, // 化肥(4小时)
    80003, // 化肥(8小时)
    80004, // 化肥(12小时)
    80011, // 有机化肥(1小时)
    80012, // 有机化肥(4小时)
    80013, // 有机化肥(8小时)
    80014, // 有机化肥(12小时)
]);

// ============ 化肥容器相关 ============

/** 化肥容器小时数上限（达到后不再继续填充） */
const FERTILIZER_CONTAINER_LIMIT_HOURS = 990;

/** 普通化肥容器道具 ID（背包中计量单位为秒） */
const NORMAL_CONTAINER_ID = 1011;
/** 有机化肥容器道具 ID */
const ORGANIC_CONTAINER_ID = 1012;

// ============ 商城化肥礼包商品 ID ============

/** 商城中普通化肥礼包的 goods_id（MallService） */
const NORMAL_FERTILIZER_MALL_GOODS_ID = 1003;

/** 普通化肥道具 ID -> 每个道具填充的小时数 */
const NORMAL_FERTILIZER_ITEM_HOURS = new Map([
    [80001, 1], [80002, 4], [80003, 8], [80004, 12],
]);
/** 有机化肥道具 ID -> 每个道具填充的小时数 */
const ORGANIC_FERTILIZER_ITEM_HOURS = new Map([
    [80011, 1], [80012, 4], [80013, 8], [80014, 12],
]);

// ============ 内部状态 ============

/** 当日已开启礼包数（进程生命周期内记录，按日期重置） */
let dailyPackOpened = 0;
let dailyPackDate = '';

/** 当日已购买礼包次数（进程生命周期内记录，按日期重置） */
let dailyPackBought = 0;
let dailyPackBoughtDate = '';

/** 最后一次购买尝试时间 (ms)，用于冷却控制 */
let lastBuyAttemptMs = 0;

/** 今日购买暂停原因（点券不足/限购/接口错误等），空字符串表示未暂停 */
let buyPausedReason = '';

/** 已发现的礼包商品缓存，每日重置（避免每次重复查询商店列表） */
let cachedPackGoods = null;

/** 定时器 */
let fertilizerTimer = null;

// ============ 协议函数 ============

/**
 * 单个物品 Use（逐个使用，支持 land_ids）
 * @param {number} itemId
 * @param {number} count
 * @returns {Promise<object>} UseReply
 */
async function useItem(itemId, count) {
    const body = types.UseRequest.encode(types.UseRequest.create({
        item_id: toLong(itemId),
        count: toLong(count),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', body);
    return types.UseReply.decode(replyBody);
}

/**
 * 批量使用多种物品（BatchUse）
 * @param {Array<{item_id: number, count: number}>} items
 * @returns {Promise<object>} BatchUseReply
 */
async function batchUseItems(items) {
    const payload = items.map(it => ({
        item_id: toLong(it.item_id),
        count: toLong(it.count),
    }));
    const body = types.BatchUseRequest.encode(types.BatchUseRequest.create({ items: payload })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'BatchUse', body);
    return types.BatchUseReply.decode(replyBody);
}

/**
 * 获取所有商店列表
 * @returns {Promise<object>} ShopProfilesReply
 */
async function getShopProfiles() {
    const body = types.ShopProfilesRequest.encode(types.ShopProfilesRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'ShopProfiles', body);
    return types.ShopProfilesReply.decode(replyBody);
}

/**
 * 获取商店商品列表
 * @param {number} shopId
 * @returns {Promise<object>} ShopInfoReply
 */
async function getShopInfo(shopId) {
    const body = types.ShopInfoRequest.encode(types.ShopInfoRequest.create({
        shop_id: toLong(shopId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'ShopInfo', body);
    return types.ShopInfoReply.decode(replyBody);
}

/**
 * 购买商品
 * @param {number} goodsId
 * @param {number} num
 * @param {number} price
 * @returns {Promise<object>} BuyGoodsReply
 */
async function buyGoods(goodsId, num, price) {
    const body = types.BuyGoodsRequest.encode(types.BuyGoodsRequest.create({
        goods_id: toLong(goodsId),
        num: toLong(num),
        price: toLong(price),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'BuyGoods', body);
    return types.BuyGoodsReply.decode(replyBody);
}

/**
 * 调用 MallService.GetMallListBySlotType 获取商城商品列表
 * @param {number} slotType - 商城类型（默认 1）
 * @returns {Promise<Array<object>>} 解码后的 MallGoods 数组
 */
async function getMallGoodsList(slotType = 1) {
    const body = types.GetMallListBySlotTypeRequest.encode(
        types.GetMallListBySlotTypeRequest.create({ slot_type: Number(slotType) || 1 }),
    ).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.mallpb.MallService', 'GetMallListBySlotType', body);
    const resp = types.GetMallListBySlotTypeResponse.decode(replyBody);
    const raw = Array.isArray(resp && resp.goods_list) ? resp.goods_list : [];
    const goods = [];
    for (const b of raw) {
        try {
            goods.push(types.MallGoods.decode(b));
        } catch (_) {
            // 单条解码失败时跳过
        }
    }
    return goods;
}

/**
 * 调用 MallService.Purchase 购买商城商品
 * @param {number} goodsId
 * @param {number} count
 * @returns {Promise<object>} PurchaseResponse
 */
async function purchaseMallGoods(goodsId, count = 1) {
    const body = types.PurchaseRequest.encode(types.PurchaseRequest.create({
        goods_id: Number(goodsId) || 0,
        count: Number(count) || 1,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.mallpb.MallService', 'Purchase', body);
    return types.PurchaseResponse.decode(replyBody);
}

/**
 * 解析 MallGoods.price 字节字段中的点券价格
 * price 字段可能是 bytes（序列化 protobuf 数据），从中读取 field=2 的 varint
 * @param {Buffer|Uint8Array|number|null} priceField
 * @returns {number} 点券价格（非负整数）
 */
function parseMallPriceValue(priceField) {
    if (priceField == null) return 0;
    if (typeof priceField === 'number') return Math.max(0, Math.floor(priceField));
    const bytes = Buffer.isBuffer(priceField) ? priceField : Buffer.from(priceField || []);
    if (!bytes.length) return 0;
    // 从序列化的 bytes 中扫描 varint 字段，取 field_number=2 的值作为价格
    let idx = 0;
    let parsed = 0;
    while (idx < bytes.length) {
        const key = bytes[idx++];
        const field = key >> 3;
        const wire = key & 0x07;
        if (wire === 0) {
            // varint
            let val = 0;
            let shift = 0;
            while (idx < bytes.length) {
                const b = bytes[idx++];
                val |= (b & 0x7f) << shift;
                if ((b & 0x80) === 0) break;
                shift += 7;
            }
            if (field === 2) parsed = val;
        } else if (wire === 1) {
            // 64-bit: skip 8 bytes
            idx += 8;
        } else if (wire === 2) {
            // length-delimited: skip length + bytes
            let len = 0;
            let shift = 0;
            while (idx < bytes.length) {
                const b = bytes[idx++];
                len |= (b & 0x7f) << shift;
                if ((b & 0x80) === 0) break;
                shift += 7;
            }
            idx += len;
        } else if (wire === 5) {
            // 32-bit: skip 4 bytes
            idx += 4;
        } else {
            break; // unknown wire type, stop parsing
        }
    }
    return Math.max(0, Math.floor(parsed || 0));
}

// ============ 核心逻辑 ============

/**
 * 重置每日计数（按日期检查）
 */
function resetDailyIfNeeded() {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (dailyPackDate !== today) {
        dailyPackDate = today;
        dailyPackOpened = 0;
    }
}

/**
 * 重置购买每日计数并清除商品缓存（bought_num 每日重置）
 */
function resetBuyDailyIfNeeded() {
    const today = new Date().toISOString().slice(0, 10);
    if (dailyPackBoughtDate !== today) {
        dailyPackBoughtDate = today;
        dailyPackBought = 0;
        buyPausedReason = '';
        cachedPackGoods = null; // bought_num 服务端每日重置，需重新查询
    }
}

/**
 * 从背包物品列表中获取点券余额
 * @param {Array} bagItems
 * @returns {number}
 */
function getCouponBalance(bagItems) {
    for (const item of bagItems) {
        if (toNum(item.id) === COUPON_ITEM_ID) {
            return toNum(item.count);
        }
    }
    return 0;
}

/**
 * 从背包物品列表中统计当前礼包数量
 * @param {Array} bagItems
 * @returns {number}
 */
function getPackStockCount(bagItems) {
    let total = 0;
    for (const item of bagItems) {
        if (FERTILIZER_PACK_IDS.has(toNum(item.id))) {
            total += toNum(item.count);
        }
    }
    return total;
}

/**
 * 通过 MallService 查找化肥礼包商品（goods_id == NORMAL_FERTILIZER_MALL_GOODS_ID）
 * @returns {Promise<{goodsId:number, price:number, name:string}|null>}
 */
async function findFertilizerMallGoods() {
    try {
        const goodsList = await getMallGoodsList(1);
        const goods = goodsList.find(g => Number(g && g.goods_id) === NORMAL_FERTILIZER_MALL_GOODS_ID);
        if (!goods) return null;
        return {
            goodsId: Number(goods.goods_id),
            price: parseMallPriceValue(goods.price),
            name: goods.name || '10小时化肥',
        };
    } catch (e) {
        logWarn('化肥购买', `MallService 查询商品失败: ${e.message}`);
        return null;
    }
}

/**
 * 遍历所有商店，找到含有化肥礼包的商品信息并缓存（旧逻辑，作为兜底）
 * @returns {Promise<Array<{shopId,goodsId,itemId,price,limitCount,boughtNum,itemCount}>>}
 */
async function findFertilizerPackGoods() {
    if (cachedPackGoods !== null) return cachedPackGoods;

    const found = [];
    try {
        const profilesReply = await getShopProfiles();
        const shops = profilesReply.shop_profiles || [];
        for (const shop of shops) {
            const shopId = toNum(shop.shop_id);
            try {
                const infoReply = await getShopInfo(shopId);
                for (const goods of (infoReply.goods_list || [])) {
                    const itemId = toNum(goods.item_id);
                    if (FERTILIZER_PACK_IDS.has(itemId)) {
                        found.push({
                            shopId,
                            goodsId: toNum(goods.id),
                            itemId,
                            price: toNum(goods.price),
                            limitCount: toNum(goods.limit_count),
                            boughtNum: toNum(goods.bought_num),
                            itemCount: toNum(goods.item_count) || 1,
                        });
                    }
                }
                await sleep(THROTTLE_DELAY_MS);
            } catch (e) {
                logWarn('化肥购买', `获取商店 ${shopId} 失败: ${e.message}`);
            }
        }
    } catch (e) {
        logWarn('化肥购买', `获取商店列表失败: ${e.message}`);
    }

    cachedPackGoods = found;
    if (found.length > 0) {
        const names = found.map(g => {
            const n = getFertilizerPackName(g.itemId);
            return `${n}(price=${g.price},limit=${g.limitCount})`;
        });
        log('化肥购买', `[兜底] 已找到礼包商品: ${names.join(', ')}`);
    } else {
        logWarn('化肥购买', '[兜底] 商城中未找到化肥礼包商品');
    }
    return found;
}

/**
 * 用点券购买化肥礼包（优先使用 MallService，失败时兜底 ShopService）
 * 包含冷却控制、每日限购、目标库存检查、失败退避等风控逻辑
 * @param {Array} bagItems - getBagItems() 返回的背包物品列表
 * @returns {Promise<number>} 本次购买的礼包总数
 */
async function buyFertilizerPacks(bagItems) {
    if (!CONFIG.autoBuyFertilizerPack) return 0;

    resetBuyDailyIfNeeded();

    // 冷却检查：两次购买尝试之间至少间隔 BUY_COOLDOWN_MS
    const nowMs = Date.now();
    if (nowMs - lastBuyAttemptMs < BUY_COOLDOWN_MS) {
        return 0;
    }

    // 今日暂停检查（点券不足/限购/接口持续失败）
    if (buyPausedReason) {
        log('化肥购买', `今日购买已暂停: ${buyPausedReason}`);
        return 0;
    }

    // 每日上限检查
    const dailyLimit = CONFIG.fertilizerPackBuyDailyLimit;
    if (dailyLimit > 0 && dailyPackBought >= dailyLimit) {
        log('化肥购买', `今日购买已达上限 (${dailyLimit})，跳过`);
        return 0;
    }

    // 目标库存检查
    const targetStock = CONFIG.fertilizerPackTargetStock;
    if (targetStock > 0) {
        const currentStock = getPackStockCount(bagItems);
        if (currentStock >= targetStock) {
            log('化肥购买', `背包礼包数量 ${currentStock} 已达目标 ${targetStock}，无需购买`);
            return 0;
        }
    }

    // 记录本次尝试时间（放在余额检查之前，避免点券不足时频繁触发）
    lastBuyAttemptMs = nowMs;

    // 点券余额
    const coupon = getCouponBalance(bagItems);
    log('化肥购买', `当前点券: ${coupon}`);

    // ── 主路径：MallService ──
    const mallGoods = await findFertilizerMallGoods();
    if (mallGoods) {
        const { goodsId, price, name } = mallGoods;
        log('化肥购买', `MallService 找到商品: ${name}(goods_id=${goodsId}, price=${price})`);

        const buyAmount = CONFIG.fertilizerPackBuyAmount;
        let toBuy = buyAmount;
        if (dailyLimit > 0) {
            toBuy = Math.min(toBuy, dailyLimit - dailyPackBought);
        }
        if (toBuy <= 0) return 0;

        // 点券余额检查（price=0 时跳过，表示免费或无法解析价格）
        if (price > 0) {
            const totalCost = price * toBuy;
            if (coupon < totalCost) {
                logWarn('化肥购买', `点券不足: ${name} 需 ${totalCost}，当前 ${coupon}`);
                buyPausedReason = `点券不足(需${totalCost},有${coupon})`;
                return 0;
            }
        }

        try {
            const reply = await purchaseMallGoods(goodsId, toBuy);
            const gotCount = Number(reply && reply.count) || toBuy;
            dailyPackBought += toBuy;
            log('化肥购买', `购买 ${name}x${toBuy}，获得礼包 ${gotCount} 个（今日已购 ${dailyPackBought}）`);
            return toBuy;
        } catch (e) {
            const msg = String((e && e.message) || '');
            logWarn('化肥购买', `MallService 购买失败: ${msg}`);
            if (msg.includes('余额不足') || msg.includes('点券不足') || msg.includes('code=1000019')) {
                buyPausedReason = `点券不足: ${msg}`;
                return 0;
            }
            if (msg.includes('限购') || msg.includes('code=1000020')) {
                buyPausedReason = `限购已满: ${msg}`;
                return 0;
            }
            logWarn('化肥购买', '尝试兜底 ShopService 购买路径');
        }
    } else {
        logWarn('化肥购买', `MallService 中未找到 goods_id=${NORMAL_FERTILIZER_MALL_GOODS_ID} 的化肥礼包，尝试兜底`);
    }

    // ── 兜底路径：ShopService ──
    const packGoods = await findFertilizerPackGoods();
    if (packGoods.length === 0) {
        buyPausedReason = '商城无化肥礼包';
        return 0;
    }

    let totalBought = 0;
    const buyAmount = CONFIG.fertilizerPackBuyAmount;

    for (const goods of packGoods) {
        // 每日上限再次检查
        if (dailyLimit > 0 && dailyPackBought >= dailyLimit) break;

        const name = getFertilizerPackName(goods.itemId);

        // 服务端限购检查
        if (goods.limitCount > 0 && goods.boughtNum >= goods.limitCount) {
            log('化肥购买', `${name} 已达限购 (${goods.boughtNum}/${goods.limitCount})，跳过`);
            continue;
        }

        // 计算本次购买数量：不超过每日剩余额度和限购剩余量
        let toBuy = buyAmount;
        if (dailyLimit > 0) {
            toBuy = Math.min(toBuy, dailyLimit - dailyPackBought);
        }
        if (goods.limitCount > 0) {
            toBuy = Math.min(toBuy, goods.limitCount - goods.boughtNum);
        }
        if (toBuy <= 0) continue;

        // 点券余额是否足够
        const totalCost = goods.price * toBuy;
        if (coupon < totalCost) {
            logWarn('化肥购买', `点券不足: ${name} 需 ${totalCost}，当前 ${coupon}`);
            buyPausedReason = `点券不足(需${totalCost},有${coupon})`;
            break;
        }

        try {
            const reply = await buyGoods(goods.goodsId, toBuy, goods.price);

            // 从回包推断获得礼包数量和消耗点券
            const getItems = reply.get_items || [];
            const gotCountFromReply = getItems.reduce((s, i) => {
                if (toNum(i.id) === goods.itemId) return s + toNum(i.count);
                return s;
            }, 0);
            const gotCount = gotCountFromReply || (() => {
                logWarn('化肥购买', `${name} 回包 get_items 为空，以预期数量 ${toBuy * goods.itemCount} 计`);
                return toBuy * goods.itemCount;
            })();

            const costItems = reply.cost_items || [];
            const costFromReply = costItems.reduce((s, i) => {
                if (toNum(i.id) === COUPON_ITEM_ID) return s + toNum(i.count);
                return s;
            }, 0);
            const costCoupons = costFromReply || (() => {
                logWarn('化肥购买', `${name} 回包 cost_items 为空，以预期点券 ${totalCost} 计`);
                return totalCost;
            })();

            dailyPackBought += toBuy;
            totalBought += toBuy;
            goods.boughtNum += toBuy; // 更新本地缓存

            log('化肥购买', `购买 ${name}x${toBuy}，消耗点券 ${costCoupons}，获得礼包 ${gotCount} 个（今日已购 ${dailyPackBought}）`);

            await sleep(THROTTLE_DELAY_MS);
        } catch (e) {
            logWarn('化肥购买', `购买 ${name} 失败: ${e.message}`);
            buyPausedReason = `购买失败: ${e.message}`;
            break;
        }
    }

    return totalBought;
}

/**
 * 开启背包中的化肥礼包
 * 按条目逐个 BatchUse（每条目之间 sleep 节流），避免批量一次性请求造成卡死
 * @param {Array} bagItems - getBagItems() 返回的背包物品列表
 * @returns {Promise<number>} 本次开启的礼包总数
 */
async function openFertilizerPacks(bagItems) {
    resetDailyIfNeeded();

    const dailyLimit = CONFIG.fertilizerPackDailyLimit;
    const packs = [];

    for (const item of bagItems) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        if (FERTILIZER_PACK_IDS.has(id) && count > 0) {
            let toOpen = count;
            if (dailyLimit > 0) {
                const remaining = dailyLimit - dailyPackOpened;
                if (remaining <= 0) {
                    log('化肥', `今日礼包开启已达上限 (${dailyLimit})，跳过`);
                    continue;
                }
                toOpen = Math.min(count, remaining);
            }
            packs.push({ item_id: id, count: toOpen });
        }
    }

    if (packs.length === 0) return 0;

    let totalOpened = 0;

    // 按条目逐个 BatchUse，每条目之间 sleep 避免请求风暴
    for (const pack of packs) {
        if (dailyLimit > 0 && dailyPackOpened >= dailyLimit) break;
        const name = getFertilizerPackName(pack.item_id);
        try {
            await batchUseItems([{ item_id: pack.item_id, count: pack.count }]);
            dailyPackOpened += pack.count;
            totalOpened += pack.count;
            log('化肥', `开启礼包 ${name}x${pack.count}`);
        } catch (e) {
            logWarn('化肥', `开启礼包 ${name} 失败: ${e.message}`);
        }
        await sleep(BATCH_USE_SLEEP_MS);
    }

    if (totalOpened > 0) {
        log('化肥', `礼包开启完成，共 ${totalOpened} 个`);
    }
    return totalOpened;
}

/**
 * 使用多余的化肥道具（当道具总数 > 目标阈值时，使用多余部分以填充容器）
 * 按条目逐个 BatchUse（每条目之间 sleep 节流），检查容器上限避免反复失败
 * @param {Array} bagItems - getBagItems() 返回的背包物品列表
 * @returns {Promise<number>} 本次使用的道具总数
 */
async function useSurplusFertilizerItems(bagItems) {
    const targetCount = CONFIG.fertilizerTargetCount;

    // 计算背包中化肥道具总数与各种明细
    const itemMap = new Map(); // item_id -> count
    for (const item of bagItems) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        if (FERTILIZER_ITEM_IDS.has(id) && count > 0) {
            itemMap.set(id, (itemMap.get(id) || 0) + count);
        }
    }

    const totalItems = [...itemMap.values()].reduce((s, c) => s + c, 0);
    if (totalItems <= targetCount) {
        if (totalItems > 0) {
            log('化肥', `道具总数 ${totalItems}，不超过目标 ${targetCount}，无需使用`);
        }
        return 0;
    }

    const surplus = totalItems - targetCount;
    log('化肥', `道具总数 ${totalItems}，超出目标 ${targetCount}，将使用 ${surplus} 个`);

    // 读取容器当前容量
    const containerHours = getContainerHoursFromBagItems(bagItems);

    // 构建要使用的列表（从数量最多的先消耗，保持均衡）
    let remaining = surplus;
    const toUse = [];
    for (const [id, count] of [...itemMap.entries()].sort((a, b) => b[1] - a[1])) {
        if (remaining <= 0) break;
        const use = Math.min(count, remaining);
        toUse.push({ item_id: id, count: use });
        remaining -= use;
    }

    let totalUsed = 0;

    // 按条目逐个 BatchUse，容器满则跳过，每条目之间 sleep 避免请求风暴
    for (const t of toUse) {
        const { type, perItemHours } = getFertilizerItemTypeAndHours(t.item_id);
        let useCount = t.count;

        // 容器上限检查：达到 990h 时跳过；未满时按剩余容量裁剪使用数量
        if (type === 'normal' || type === 'organic') {
            const currentHours = type === 'normal' ? containerHours.normal : containerHours.organic;
            if (currentHours >= FERTILIZER_CONTAINER_LIMIT_HOURS) {
                const typeName = type === 'normal' ? '普通' : '有机';
                log('化肥', `${typeName}化肥容器已达到 ${FERTILIZER_CONTAINER_LIMIT_HOURS} 小时上限，跳过填充`);
                continue;
            }
            if (perItemHours > 0) {
                const remainHours = Math.max(0, FERTILIZER_CONTAINER_LIMIT_HOURS - currentHours);
                const maxCountByHours = Math.floor(remainHours / perItemHours);
                useCount = Math.min(useCount, maxCountByHours);
                if (useCount <= 0) continue;
            }
        }

        const hours = getItemHours(t.item_id);
        const typeName = t.item_id >= 80011 ? '有机化肥' : '化肥';
        try {
            await batchUseItems([{ item_id: t.item_id, count: useCount }]);
            totalUsed += useCount;
            log('化肥', `使用 ${typeName}(${hours}h)x${useCount}`);
            // 本地更新容器估算值，避免后续条目重复超量
            if (type === 'normal' && perItemHours > 0) containerHours.normal += useCount * perItemHours;
            if (type === 'organic' && perItemHours > 0) containerHours.organic += useCount * perItemHours;
        } catch (e) {
            if (isFertilizerContainerFullError(e)) {
                const cTypeName = type === 'normal' ? '普通' : '有机';
                log('化肥', `${cTypeName}化肥容器已满，跳过剩余填充`);
                // 标记容器已满，后续同类道具直接跳过
                if (type === 'normal') containerHours.normal = FERTILIZER_CONTAINER_LIMIT_HOURS;
                if (type === 'organic') containerHours.organic = FERTILIZER_CONTAINER_LIMIT_HOURS;
            } else {
                logWarn('化肥', `使用道具 ${t.item_id} 失败: ${e.message}`);
            }
        }
        await sleep(BATCH_USE_SLEEP_MS);
    }

    if (totalUsed > 0) {
        log('化肥', `化肥道具使用完成，共 ${totalUsed} 个`);
    }
    return totalUsed;
}

/**
 * 从背包物品列表中读取化肥容器当前小时数
 * 容器道具在背包中以秒为单位存储
 * @param {Array} items - getBagItems() 返回的背包物品列表
 * @returns {{ normal: number, organic: number }} 当前容器小时数
 */
function getContainerHoursFromBagItems(items) {
    let normalSec = 0;
    let organicSec = 0;
    for (const it of (items || [])) {
        const id = toNum(it && it.id);
        const count = Math.max(0, toNum(it && it.count));
        if (id === NORMAL_CONTAINER_ID) normalSec = count;
        if (id === ORGANIC_CONTAINER_ID) organicSec = count;
    }
    return {
        normal: normalSec / 3600,
        organic: organicSec / 3600,
    };
}

/**
 * 根据化肥道具 ID 判断类型（normal/organic/other）及每个道具对应的填充小时数
 * @param {number} itemId
 * @returns {{ type: string, perItemHours: number }}
 */
function getFertilizerItemTypeAndHours(itemId) {
    const id = Number(itemId) || 0;
    if (NORMAL_FERTILIZER_ITEM_HOURS.has(id)) {
        return { type: 'normal', perItemHours: NORMAL_FERTILIZER_ITEM_HOURS.get(id) };
    }
    if (ORGANIC_FERTILIZER_ITEM_HOURS.has(id)) {
        return { type: 'organic', perItemHours: ORGANIC_FERTILIZER_ITEM_HOURS.get(id) };
    }
    return { type: 'other', perItemHours: 0 };
}

/**
 * 判断错误是否为化肥容器已满
 * @param {Error} err
 * @returns {boolean}
 */
function isFertilizerContainerFullError(err) {
    const msg = String((err && err.message) || '');
    return msg.includes('code=1003002')
        || msg.includes('化肥容器已满')
        || msg.includes('化肥容器已达到上限');
}

/**
 * 从物品 ID 推断小时数（仅用于日志）
 */
function getItemHours(itemId) {
    const map = { 80001: 1, 80002: 4, 80003: 8, 80004: 12, 80011: 1, 80012: 4, 80013: 8, 80014: 12 };
    return map[itemId] || '?';
}

/**
 * 根据礼包物品 ID 返回可读名称
 */
function getFertilizerPackName(itemId) {
    return itemId === 100003 ? '化肥礼包' : '有机化肥礼包';
}

// ============ 对外主入口 ============

/**
 * 执行一次化肥自动化任务（开礼包 → 使用多余道具）
 * 异常全部捕获，不中断主流程。
 */
async function runFertilizerTask() {
    if (!CONFIG.autoUseFertilizer && !CONFIG.autoBuyFertilizerPack) return;

    try {
        const bagReply = await getBag();
        const items = getBagItems(bagReply);

        // 1. 先用点券购买化肥礼包（若启用）
        await buyFertilizerPacks(items);

        if (!CONFIG.autoUseFertilizer) return;

        // 2. 刷新背包（购买后背包可能变化）
        let latestItems = items;
        if (CONFIG.autoBuyFertilizerPack) {
            try {
                const freshBag = await getBag();
                latestItems = getBagItems(freshBag);
            } catch (e) {
                logWarn('化肥', `刷新背包失败: ${e.message}，使用旧数据继续`);
            }
        }

        const packsOpened = await openFertilizerPacks(latestItems);

        // 3. 若开了礼包，重新获取背包以拿到最新道具数量
        if (packsOpened > 0) {
            try {
                const freshBag = await getBag();
                latestItems = getBagItems(freshBag);
            } catch (e) {
                logWarn('化肥', `刷新背包失败: ${e.message}，使用旧数据继续`);
            }
        }

        await useSurplusFertilizerItems(latestItems);
    } catch (e) {
        logWarn('化肥', `化肥任务异常: ${e.message}`);
    }
}

/**
 * 启动定期化肥任务定时器
 * @param {number} intervalMs - 间隔毫秒数（默认 1 小时）
 */
function startFertilizerLoop(intervalMs = DEFAULT_FERTILIZER_INTERVAL_MS) {
    if (!CONFIG.autoUseFertilizer && !CONFIG.autoBuyFertilizerPack) return;
    if (fertilizerTimer) return;

    // 延迟首次执行（等登录流程稳定）
    setTimeout(() => {
        runFertilizerTask();
        fertilizerTimer = setInterval(() => runFertilizerTask(), intervalMs);
    }, INITIAL_DELAY_MS);
}

/**
 * 停止定期化肥任务定时器
 */
function stopFertilizerLoop() {
    if (fertilizerTimer) {
        clearInterval(fertilizerTimer);
        fertilizerTimer = null;
    }
    cachedPackGoods = null; // 重置商品缓存，重连后重新查询
}

// ============ 纯函数（可单独测试）============

/**
 * 从背包物品列表中识别化肥礼包
 * @param {Array} bagItems
 * @returns {Array<{id: number, count: number}>}
 */
function identifyFertilizerPacks(bagItems) {
    const result = [];
    for (const item of bagItems) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        if (FERTILIZER_PACK_IDS.has(id) && count > 0) {
            result.push({ id, count });
        }
    }
    return result;
}

/**
 * 从背包物品列表中识别化肥道具并计算超出阈值的用量
 * @param {Array} bagItems
 * @param {number} targetCount
 * @returns {{ total: number, surplus: number, toUse: Array<{item_id: number, count: number}> }}
 */
function calcFertilizerItemUsage(bagItems, targetCount) {
    const itemMap = new Map();
    for (const item of bagItems) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        if (FERTILIZER_ITEM_IDS.has(id) && count > 0) {
            itemMap.set(id, (itemMap.get(id) || 0) + count);
        }
    }

    const total = [...itemMap.values()].reduce((s, c) => s + c, 0);
    const surplus = Math.max(0, total - targetCount);
    const toUse = [];

    if (surplus > 0) {
        let remaining = surplus;
        for (const [id, count] of [...itemMap.entries()].sort((a, b) => b[1] - a[1])) {
            if (remaining <= 0) break;
            const use = Math.min(count, remaining);
            toUse.push({ item_id: id, count: use });
            remaining -= use;
        }
    }

    return { total, surplus, toUse };
}

module.exports = {
    runFertilizerTask,
    startFertilizerLoop,
    stopFertilizerLoop,
    // 纯函数（测试/调试用）
    identifyFertilizerPacks,
    calcFertilizerItemUsage,
    getCouponBalance,
    getPackStockCount,
    getContainerHoursFromBagItems,
    getFertilizerItemTypeAndHours,
    isFertilizerContainerFullError,
    parseMallPriceValue,
    FERTILIZER_PACK_IDS,
    FERTILIZER_ITEM_IDS,
    COUPON_ITEM_ID,
    FERTILIZER_CONTAINER_LIMIT_HOURS,
    NORMAL_CONTAINER_ID,
    ORGANIC_CONTAINER_ID,
    NORMAL_FERTILIZER_MALL_GOODS_ID,
};
