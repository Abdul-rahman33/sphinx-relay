import * as moment from 'moment'
import * as mqtt from 'mqtt'
import { IClientSubscribeOptions } from 'mqtt'
import fetch from 'node-fetch'
import * as LND from '../grpc/lightning'
import {
  Contact,
  models,
  sequelize,
  ChatRecord,
  Message,
  isPostgres,
  ContactRecord,
} from '../models'
import type { Tribe } from '../models/ts/tribe'
import { sleep, asyncForEach } from '../helpers'
export { declare_bot, delete_bot }
import { txIndexFromChannelId } from '../grpc/interfaces'
import * as zbase32 from './zbase32'
import { logging, sphinxLogger } from './logger'
import { getProxyXpub, isProxy } from './proxy'
import { loadConfig } from './config'
import { makeBotsJSON, declare_bot, delete_bot } from './tribeBots'

const config = loadConfig()

// MAIN CLIENTS STATE (caching already connected clients)
// {pubkey: {host: Client} }
const CLIENTS: { [k: string]: { [k: string]: mqtt.Client } } = {}

interface CacheMsgInput {
  preview: string
  chat_uuid: string
  chat_id: number
  order: string
  offset: number | '' | undefined
  limit: number | '' | undefined
  dateToReturn?: string
}

const optz: IClientSubscribeOptions = { qos: 0 }

// XPUB RESPONSE FROM PROXY
type XpubRes = { xpub: string; pubkey: string }
let XPUB_RES: XpubRes | undefined

// this runs at relay startup
export async function connect(
  onMessage: (topic: string, message: Buffer) => void
): Promise<void> {
  initAndSubscribeTopics(onMessage)
}

async function initAndSubscribeTopics(
  onMessage: (topic: string, message: Buffer) => void
): Promise<void> {
  sphinxLogger.debug('initAndSubscribeTopics', logging.Tribes)

  const host = getHost()
  try {
    sphinxLogger.debug(`contacts where isOwner true`, logging.Tribes)
    const allOwners: Contact[] = (await models.Contact.findAll({
      where: { isOwner: true },
    })) as Contact[]

    // We found no owners
    if (!(allOwners && allOwners.length)) return

    sphinxLogger.debug(`looping all the owners and subscribing`, logging.Tribes)
    await asyncForEach(allOwners, async (c) => {
      if (c.publicKey && c.publicKey.length === 66) {
        // if is proxy and no auth token dont subscribe yet... will subscribe when signed up
        if (isProxy() && !c.authToken) return

        sphinxLogger.debug(`lazyClient for ${c.publicKey}`, logging.Tribes)
        await lazyClient(c, host, onMessage, allOwners)
      }
    })

    sphinxLogger.info('[TRIBES] all CLIENTS + subscriptions complete!')
  } catch (e) {
    sphinxLogger.error(`TRIBES ERROR, initAndSubscribeTopics ${e}`)
  }
}

interface LazyClientRes {
  client: mqtt.Client
  isFresh: boolean
}

// In this function we are initializing the mqtt client
// for every user on this relay
async function initializeClient(
  contact: Contact,
  host: string,
  onMessage?: (topic: string, message: Buffer) => void,
  xpubres?: XpubRes,
  allOwners?: Contact[]
): Promise<LazyClientRes> {
  sphinxLogger.debug(`Initializing client`, logging.Tribes)
  return new Promise(async (resolve) => {
    let connected = false
    async function reconnect() {
      try {
        let signer = contact.publicKey
        if (xpubres && xpubres.pubkey) signer = xpubres.pubkey

        sphinxLogger.debug(
          `Initializing client, genSignedTimestamp`,
          logging.Tribes
        )
        const pwd = await genSignedTimestamp(signer)
        sphinxLogger.debug(
          `Initializing client, finished genSignedTimestamp`,
          logging.Tribes
        )
        if (connected) return
        const url = mqttURL(host)
        let username = contact.publicKey
        if (xpubres && xpubres.xpub) username = xpubres.xpub

        sphinxLogger.info(`connect with token: ${pwd}`, logging.Tribes)
        const cl = mqtt.connect(url, {
          username: username,
          password: pwd,
          reconnectPeriod: 0, // dont auto reconnect
        })

        sphinxLogger.info(`try to connect: ${url}`, logging.Tribes)
        cl.on('connect', async function () {
          // first check if its already connected to this host (in case it takes a long time)
          connected = true
          if (
            CLIENTS[username] &&
            CLIENTS[username][host] &&
            CLIENTS[username][host].connected
          ) {
            resolve({ client: CLIENTS[username][host], isFresh: false })
            return
          }
          sphinxLogger.info(`connected!`, logging.Tribes)

          // ADD TO MAIN CLIENTS STATE
          if (!CLIENTS[username]) CLIENTS[username] = {}
          CLIENTS[username][host] = cl

          // for HD-enabled proxy, subscribe to all owners pubkeys here
          if (xpubres && allOwners) {
            for (const o of allOwners) {
              // contact #1 has his own client
              const isFirstUser = contact.id === 1
              if (!isFirstUser) await specialSubscribe(cl, o)
            }
          } else {
            // else just this contact (legacy)
            await specialSubscribe(cl, contact)
          }

          // If we close the connection
          cl.on('close', function (e) {
            sphinxLogger.info(`CLOSE ${e}`, logging.Tribes)
            connected = false

            // REMOVE FROM MAIN CLIENTS STATE
            if (CLIENTS[username] && CLIENTS[username][host]) {
              delete CLIENTS[username][host]
            }
          })

          // If there is an error on any connection
          cl.on('error', function (e) {
            sphinxLogger.error(`error:  ${e.message}`, logging.Tribes)
          })

          // message type what we do on a new message
          cl.on('message', function (topic, message) {
            sphinxLogger.debug(
              `============>>>>> GOT A MSG ${topic} ${message}`,
              logging.Tribes
            )
            if (onMessage) onMessage(topic, message)
          })

          // new client! isFresh = true
          resolve({ client: cl, isFresh: true })
        })
      } catch (e) {
        sphinxLogger.error(`error initializing ${e}`, logging.Tribes)
      }
    }

    // retrying connection till sucessfull
    while (true) {
      if (!connected) {
        reconnect()
      }
      await sleep(5000 + Math.round(Math.random() * 8000))
    }
  })
}

async function proxyXpub(): Promise<XpubRes> {
  if (XPUB_RES && XPUB_RES.pubkey && XPUB_RES.pubkey) return XPUB_RES
  const xpub_res = await getProxyXpub()
  XPUB_RES = xpub_res
  return xpub_res
}

async function lazyClient(
  contact: Contact,
  host: string,
  onMessage?: (topic: string, message: Buffer) => void,
  allOwners?: Contact[]
): Promise<LazyClientRes> {
  let username = contact.publicKey
  let xpubres: XpubRes | undefined
  // "first user" is the pubkey of the lightning node behind proxy
  // they DO NOT use the xpub auth
  const isFirstUser = contact.id === 1
  if (config.proxy_hd_keys && !isFirstUser) {
    xpubres = await proxyXpub()
    // set the username to be the xpub
    if (xpubres?.xpub) username = xpubres?.xpub
  }
  if (
    CLIENTS[username] &&
    CLIENTS[username][host] &&
    CLIENTS[username][host].connected
  ) {
    return { client: CLIENTS[username][host], isFresh: false }
  }
  return await initializeClient(contact, host, onMessage, xpubres, allOwners)
}

export async function newSubscription(
  c: Contact,
  onMessage: (topic: string, message: Buffer) => void
) {
  console.log('=> newSubscription:', c.publicKey)
  const host = getHost()
  const lazy = await lazyClient(c, host, onMessage)
  if (!lazy.isFresh) {
    // if its a cached client (HD proxy mode, 2nd virtual owner)
    await specialSubscribe(lazy.client, c)
  }
}

function specialSubscribe(cl: mqtt.Client, c: Contact) {
  if (config.proxy_hd_keys && c.id != 1 && c.routeHint) {
    const index = txIndexFromChannelId(parseRouteHint(c.routeHint))
    hdSubscribe(c.publicKey, index, cl)
  } else {
    cl.subscribe(`${c.publicKey}/#`)
  }
}

export async function publish(
  topic: string,
  msg: string,
  owner: Contact,
  cb: () => void,
  isFirstUser?: boolean
): Promise<void> {
  if (owner.publicKey.length !== 66) {
    return sphinxLogger.warning('invalid pubkey, not 66 len')
  }
  const host = getHost()
  const lazy = await lazyClient(owner, host)
  if (lazy?.client)
    lazy.client.publish(topic, msg, optz, function (err) {
      if (err) sphinxLogger.error(`error publishing ${err}`, logging.Tribes)
      else if (cb) cb()
    })
}

// async function subExtraHostsForTenant(
//   tenant: number,
//   pubkey: string,
//   onMessage: (topic: string, message: Buffer) => void
// ) {
//   const host = getHost()
//   const externalTribes = await models.Chat.findAll({
//     where: {
//       tenant,
//       host: { [Op.ne]: host }, // not the host from config
//     },
//   })
//   if (!(externalTribes && externalTribes.length)) return
//   const usedHosts: string[] = []
//   externalTribes.forEach(async (et: Chat) => {
//     if (usedHosts.includes(et.host)) return
//     usedHosts.push(et.host) // dont do it twice
//     const client = await lazyClient(pubkey, host, onMessage)
//     client.subscribe(`${pubkey}/#`, optz, function (err) {
//       if (err) sphinxLogger.error(`subscribe error 2 ${err}`, logging.Tribes)
//     })
//   })
// }

export function printTribesClients(): string {
  const ret = {}
  Object.entries(CLIENTS).forEach((entry) => {
    const pk = entry[0]
    const obj = entry[1]
    ret[pk] = {}
    Object.keys(obj).forEach((host) => {
      ret[pk][host] = true
    })
  })
  return JSON.stringify(ret)
}

export async function addExtraHost(
  contact: Contact,
  host: string,
  onMessage: (topic: string, message: Buffer) => void
): Promise<void> {
  const pubkey = contact.publicKey
  // console.log("ADD EXTRA HOST", printTribesClients(), host);
  if (getHost() === host) return // not for default host
  if (CLIENTS[pubkey] && CLIENTS[pubkey][host]) return // already exists
  await lazyClient(contact, host, onMessage)
  // client.subscribe(`${pubkey}/#`, optz)
}

function mqttURL(h: string) {
  let host = config.mqtt_host || h
  let protocol = 'tls'
  if (config.tribes_insecure) {
    protocol = 'tcp'
  }
  let port = 8883
  if (config.tribes_mqtt_port) {
    port = config.tribes_mqtt_port
  }
  if (host.includes(':')) {
    const arr = host.split(':')
    host = arr[0]
  }
  return `${protocol}://${host}:${port}`
}

// for proxy, need to get all isOwner contacts and their owned chats
// async function updateTribeStats(myPubkey) {
//   if (isProxy()) return // skip on proxy for now?
//   const myTribes = (await models.Chat.findAll({
//     where: {
//       ownerPubkey: myPubkey,
//       deleted: false,
//     },
//   })) as Chat[]
//   await asyncForEach(myTribes, async (tribe) => {
//     try {
//       const contactIds = JSON.parse(tribe.contactIds)
//       const member_count = (contactIds && contactIds.length) || 0
//       await putstats({
//         uuid: tribe.uuid,
//         host: tribe.host,
//         member_count,
//         chatId: tribe.id,
//         owner_pubkey: myPubkey,
//       })
//     } catch (e) {
//       // dont care about the error
//     }
//   })
//   if (myTribes.length) {
//     sphinxLogger.info(
//       `updated stats for ${myTribes.length} tribes`,
//       logging.Tribes
//     )
//   }
// }

// export async function subscribe(
//   topic: string,
//   onMessage: (topic: string, message: Buffer) => void
// ): Promise<void> {
//   const pubkey = topic.split('/')[0]
//   if (pubkey.length !== 66) return
//   const host = getHost()
//   const client = await lazyClient(pubkey, host, onMessage)
//   if (client)
//     client.subscribe(topic, function () {
//       sphinxLogger.info(`added sub ${host} ${topic}`, logging.Tribes)
//     })
// }

export async function getTribeOwnersChatByUUID(uuid: string): Promise<any> {
  const isOwner = isPostgres() ? "'t'" : '1'
  try {
    const r = (await sequelize.query(
      `
      SELECT sphinx_chats.* FROM sphinx_chats
      INNER JOIN sphinx_contacts
      ON sphinx_chats.owner_pubkey = sphinx_contacts.public_key
      AND sphinx_contacts.is_owner = ${isOwner}
      AND sphinx_contacts.id = sphinx_chats.tenant
      AND sphinx_chats.uuid = '${uuid}'`,
      {
        model: models.Chat,
        mapToModel: true, // pass true here if you have any mapped fields
      }
    )) as ChatRecord[]
    // console.log('=> getTribeOwnersChatByUUID r:', r)
    return r && r[0] && r[0].dataValues
  } catch (e) {
    sphinxLogger.error(e)
  }
}

// good name? made this because 2 functions used similar object pattern args
export interface TribeInterface {
  uuid: string
  name: string
  description: string
  tags: any[]
  img: string
  group_key?: string
  host: string
  price_per_message: number
  price_to_join: number
  owner_alias: string
  owner_pubkey: string
  escrow_amount: number
  escrow_millis: number
  unlisted: boolean
  is_private: boolean
  app_url: string
  feed_url: string
  feed_type: number
  deleted?: boolean
  owner_route_hint: string
  pin: string
  profile_filters?: string
}

export async function declare({
  uuid,
  name,
  description,
  tags,
  img,
  group_key,
  host,
  price_per_message,
  price_to_join,
  owner_alias,
  owner_pubkey,
  escrow_amount,
  escrow_millis,
  unlisted,
  is_private,
  app_url,
  feed_url,
  feed_type,
  owner_route_hint,
  pin,
  profile_filters,
}: TribeInterface): Promise<void> {
  try {
    let protocol = 'https'
    if (config.tribes_insecure) protocol = 'http'
    const r = await fetch(protocol + '://' + host + '/tribes', {
      method: 'POST',
      body: JSON.stringify({
        uuid,
        group_key,
        name,
        description,
        tags,
        img: img || '',
        price_per_message: price_per_message || 0,
        price_to_join: price_to_join || 0,
        owner_alias,
        owner_pubkey,
        escrow_amount: escrow_amount || 0,
        escrow_millis: escrow_millis || 0,
        unlisted: unlisted || false,
        private: is_private || false,
        app_url: app_url || '',
        feed_url: feed_url || '',
        feed_type: feed_type || 0,
        owner_route_hint: owner_route_hint || '',
        pin: pin || '',
        profile_filters,
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!r.ok) {
      throw 'failed to create tribe ' + r.status
    }
    // const j = await r.json()
  } catch (e) {
    sphinxLogger.error(`unauthorized to declare`, logging.Tribes)
    throw e
  }
}

export async function edit({
  uuid,
  host,
  name,
  description,
  tags,
  img,
  price_per_message,
  price_to_join,
  owner_alias,
  escrow_amount,
  escrow_millis,
  unlisted,
  is_private,
  app_url,
  feed_url,
  feed_type,
  deleted,
  owner_route_hint,
  owner_pubkey,
  pin,
  profile_filters,
}: TribeInterface): Promise<void> {
  try {
    const token = await genSignedTimestamp(owner_pubkey)
    let protocol = 'https'
    if (config.tribes_insecure) protocol = 'http'
    const r = await fetch(protocol + '://' + host + '/tribe?token=' + token, {
      method: 'PUT',
      body: JSON.stringify({
        uuid,
        name,
        description,
        tags,
        img: img || '',
        price_per_message: price_per_message || 0,
        price_to_join: price_to_join || 0,
        escrow_amount: escrow_amount || 0,
        escrow_millis: escrow_millis || 0,
        owner_alias,
        unlisted: unlisted || false,
        private: is_private || false,
        deleted: deleted || false,
        app_url: app_url || '',
        feed_url: feed_url || '',
        feed_type: feed_type || 0,
        owner_route_hint: owner_route_hint || '',
        pin: pin || '',
        profile_filters,
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!r.ok) {
      throw 'failed to edit tribe ' + r.status
    }
    // const j = await r.json()
  } catch (e) {
    sphinxLogger.error(`unauthorized to edit`, logging.Tribes)
    throw e
  }
}

export async function delete_tribe(
  uuid: string,
  owner_pubkey: string
): Promise<void> {
  const host = getHost()
  try {
    const token = await genSignedTimestamp(owner_pubkey)
    let protocol = 'https'
    if (config.tribes_insecure) protocol = 'http'
    const r = await fetch(
      `${protocol}://${host}/tribe/${uuid}?token=${token}`,
      {
        method: 'DELETE',
      }
    )
    if (!r.ok) {
      throw 'failed to delete tribe ' + r.status
    }
    // const j = await r.json()
  } catch (e) {
    sphinxLogger.error(`unauthorized to delete`, logging.Tribes)
    throw e
  }
}

export async function get_tribe_data(uuid: string): Promise<Tribe> {
  const host = getHost()
  try {
    let protocol = 'https'
    if (config.tribes_insecure) protocol = 'http'
    const r = await fetch(`${protocol}://${host}/tribes/${uuid}`)
    if (!r.ok) {
      throw 'failed to get tribe ' + r.status
    }
    const j = await r.json()
    return j
  } catch (e) {
    sphinxLogger.error(`couldnt get tribe`, logging.Tribes)
    throw e
  }
}

export async function putActivity(
  uuid: string,
  host: string,
  owner_pubkey: string
): Promise<void> {
  try {
    const token = await genSignedTimestamp(owner_pubkey)
    let protocol = 'https'
    if (config.tribes_insecure) protocol = 'http'
    await fetch(`${protocol}://${host}/tribeactivity/${uuid}?token=` + token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    sphinxLogger.error(`unauthorized to putActivity`, logging.Tribes)
    throw e
  }
}

export async function putstats({
  uuid,
  host,
  member_count,
  chatId,
  owner_pubkey,
}: {
  uuid: string
  host: string
  member_count: number
  chatId: number
  owner_pubkey: string
}): Promise<void> {
  if (!uuid) return
  const bots = await makeBotsJSON(chatId)
  try {
    const token = await genSignedTimestamp(owner_pubkey)
    let protocol = 'https'
    if (config.tribes_insecure) protocol = 'http'
    await fetch(protocol + '://' + host + '/tribestats?token=' + token, {
      method: 'PUT',
      body: JSON.stringify({
        uuid,
        member_count,
        bots: JSON.stringify(bots || []),
      }),
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    sphinxLogger.error(`unauthorized to putstats`, logging.Tribes)
    throw e
  }
}

export async function createChannel({
  tribe_uuid,
  host,
  name,
  owner_pubkey,
}: {
  tribe_uuid: string
  host: string
  name: string
  owner_pubkey: string
}) {
  if (!tribe_uuid) return
  if (!name) return
  try {
    const token = await genSignedTimestamp(owner_pubkey)
    let protocol = 'https'
    if (config.tribes_insecure) protocol = 'http'
    const r = await fetch(protocol + '://' + host + '/channel?token=' + token, {
      method: 'POST',
      body: JSON.stringify({
        tribe_uuid,
        name,
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!r.ok) {
      throw 'failed to create tribe channel ' + r.status
    }
    const j = await r.json()
    return j
  } catch (e) {
    sphinxLogger.error(`unauthorized to create channel`, logging.Tribes)
    throw e
  }
}

export async function deleteChannel({
  id,
  host,
  owner_pubkey,
}: {
  id: number
  host: string
  owner_pubkey: string
}) {
  if (!id) return
  try {
    const token = await genSignedTimestamp(owner_pubkey)
    let protocol = 'https'
    if (config.tribes_insecure) protocol = 'http'
    const r = await fetch(
      protocol + '://' + host + '/channel/' + id + '?token=' + token,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      }
    )
    if (!r.ok) {
      throw 'failed to delete channel' + r.status
    }
    const j = await r.json()
    return j
  } catch (e) {
    sphinxLogger.error(`unauthorized to create channel`, logging.Tribes)
    throw e
  }
}

// Creates a signed timestamp with the
// hosts public key
export async function genSignedTimestamp(ownerPubkey: string): Promise<string> {
  sphinxLogger.debug(`genSignedTimestamp, start`, logging.Tribes)
  const now = moment().unix()

  sphinxLogger.debug(`genSignedTimestamp, loading lightining`, logging.Tribes)
  const lightining = await LND.loadLightning()

  let contact
  try {
    contact = (await models.Contact.findOne({
      where: { isOwner: true, publicKey: ownerPubkey },
    })) as ContactRecord
  } catch (e) {
    sphinxLogger.error(
      `genSignedTimestamp, failed to get contact ${e}`,
      logging.Tribes
    )
    throw e
  }

  const tsBytes = Buffer.from(now.toString(16), 'hex')
  const utf8Sign = LND.isCLN(lightining) && contact && contact.id === 1
  let sig = ''
  if (utf8Sign) {
    const bytesBase64 = urlBase64(tsBytes)
    const bytesUtf8 = Buffer.from(bytesBase64, 'utf8')
    sig = await LND.signBuffer(bytesUtf8, ownerPubkey)
  } else {
    sig = await LND.signBuffer(tsBytes, ownerPubkey)
  }
  const sigBytes = zbase32.decode(sig)
  const totalLength = tsBytes.length + sigBytes.length
  const buf = Buffer.concat([tsBytes, sigBytes], totalLength)
  return utf8Sign ? '.' + urlBase64(buf) : urlBase64(buf)
}

export async function verifySignedTimestamp(
  stsBase64: string
): Promise<string | undefined> {
  const stsBuf = Buffer.from(stsBase64, 'base64')
  const sig = stsBuf.subarray(4, 92)
  const sigZbase32 = zbase32.encode(sig)
  const r = await LND.verifyBytes(stsBuf.subarray(0, 4), sigZbase32) // sig needs to be zbase32 :(
  if (r.valid) {
    return r.pubkey
  }
}

export function getHost(): string {
  return config.tribes_host || ''
}

function urlBase64(buf: Buffer): string {
  return buf.toString('base64').replace(/\//g, '_').replace(/\+/g, '-')
}

async function hdSubscribe(pubkey: string, index: number, client: mqtt.Client) {
  try {
    await subscribeAndCheck(client, `${pubkey}/#`)
  } catch (e) {
    try {
      console.log('=> first time connect')
      await subscribeAndCheck(client, `${pubkey}/INDEX_${index}`)
      await subscribeAndCheck(client, `${pubkey}/#`)
    } catch (error) {
      console.log(error)
      sphinxLogger.error([`error subscribing`, error, logging.Tribes])
    }
  }
}

function subscribeAndCheck(client: mqtt.Client, topic: string) {
  return new Promise<void>((resolve, reject) => {
    try {
      client.subscribe(topic, function (err, granted) {
        if (!err) {
          const qos = granted && granted[0] && granted[0].qos
          // https://github.com/mqttjs/MQTT.js/pull/351
          if ([0, 1, 2].includes(qos)) {
            sphinxLogger.info(`subscribed! ${granted[0].topic}`, logging.Tribes)
            resolve()
          } else {
            reject(`Could not subscribe topic: ${topic}`)
          }
        } else {
          console.log(err)
          sphinxLogger.error([`error subscribing`, err], logging.Tribes)
          reject()
        }
      })
    } catch (error) {
      console.log(error)
      reject()
    }
  })
}

function parseRouteHint(routeHint) {
  return routeHint.substring(routeHint.indexOf(':') + 1, routeHint.length)
}

export async function getCacheMsg({
  preview,
  chat_uuid,
  chat_id,
  order,
  offset,
  limit,
  dateToReturn,
}: CacheMsgInput) {
  try {
    let protocol = 'https'
    if (config.tribes_insecure) protocol = 'http'
    const r = await fetch(
      `${protocol}://${preview}/api/msgs/${chat_uuid}?limit=${limit}&offset=${offset}&order=${order}&date=${dateToReturn}`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }
    )
    if (!r.ok) {
      throw `get cache message for tribe with uuid: ${chat_uuid} ` + r.status
    }
    const res = await r.json()
    const updatedCacheMsg: Message[] = []

    for (let i = 0; i < res.length; i++) {
      const msg = res[i]
      updatedCacheMsg.push({ ...msg, chat_id, chatId: chat_id, cached: true })
    }
    return updatedCacheMsg
  } catch (error) {
    sphinxLogger.error([
      `unanle to get cache message for tribe with uuid: ${chat_uuid}`,
      logging.Tribes,
    ])
    return []
  }
}

export async function verifyTribePreviewUrl(url: string) {
  try {
    let protocol = 'https'
    if (config.tribes_insecure) protocol = 'http'

    const r = await fetch(`${protocol}://${url}/api/pubkeys`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!r.ok) {
      throw `could not verify cache server` + r.status
    }
    const res = await r.json()
    return res
  } catch (error) {
    console.log(error)
    throw `could not verify cache server`
  }
}

export async function updateRemoteTribeServer({
  server,
  preview_url,
  chat_uuid,
  owner_pubkey,
}: {
  server: string
  preview_url: string
  chat_uuid: string
  owner_pubkey: string
}) {
  try {
    let protocol = 'https'
    const token = await genSignedTimestamp(owner_pubkey)
    if (config.tribes_insecure) protocol = 'http'
    const r = await fetch(
      `${protocol}://${server}/tribepreview/${chat_uuid}?preview=${preview_url}&token=${token}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
      }
    )
    if (!r.ok) {
      throw `could not update tribe server with preview url ` + r.status
    }
    const res = await r.json()
    return res
  } catch (error) {
    console.log(error)
    throw `could not update tribe server with preview url`
  }
}
