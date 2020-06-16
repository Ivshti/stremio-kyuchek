const yaml = require('js-yaml')
const fs = require('fs')
const promisify = require('util').promisify
const readFile = promisify(fs.readFile.bind(fs))
const writeFile = promisify(fs.writeFile.bind(fs))
const mkdirp = require('mkdirp')
const path = require('path')
const assert = require('assert')
const url = require('url')

async function generateAddon(yamlPath, addonPath) {
	const doc = yaml.safeLoad(await readFile(yamlPath, 'utf8'))
	assert.ok(doc.addon, 'has addon field')
	assert.ok(doc.catalog, 'has catalog')
	const cat = doc.catalog
	const id = `com.autogen.${cat.type}`
	await writeToFile(path.join(addonPath, 'manifest.json'), {
		id,
		name: doc.addon.name,
		version: doc.addon.version,
		description: doc.addon.description || '',
		resources: ['meta'],
		types: [cat.type],
		idPrefixes: [`${id}:`],
		catalogs: [{ type: cat.type, id: 'main', name: doc.addon.name }]
	})
	const catEntries = Object.entries(cat.items)
	const metas = catEntries.map(([name, items]) => {
		const thumbEntry = items.find(x => x.thumb)
		const thumb = thumbEntry ? thumbEntry.thumb : videoToThumb(videos[0])
		return {
			id: `${id}:${name}`,
			name,
			poster: thumb,
			posterShape: 'landscape',
			background: thumb,
			type: cat.type,
		}
	})
	await writeToFile(path.join(addonPath, `catalog/${cat.type}/main.json`), { metas })
	await Promise.all(catEntries.map(([name, items], i) => {
		const videos = items.filter(x => typeof x === 'string' && x.includes('youtube.com'))
		if (!videos.length) throw new Error(`catalog ${name} does not have any youtube videos listed`)
		const metaId = `${id}:${name}`
		return writeToFile(path.join(addonPath, `meta/${cat.type}/${metaId}.json`), {
			meta: {
				...metas[i],
				videos: videos.map(videoToObject)
			}
		})
		
	}))
}

async function writeToFile(fpath, content) {
	await mkdirp(path.dirname(fpath))
	await writeFile(fpath, JSON.stringify(content))
}

function videoToThumb(videoUrl) {
	const { v } = url.parse(videoUrl, true).query
	return `https://i.ytimg.com/vi/${v}/hqdefault.jpg`
}
function videoToObject(videoUrl) {
	const { v } = url.parse(videoUrl, true).query
	return {
		id: v,
		title: '', // @TODO
		streams: [{ yt_id: v }],
		thumbnail: `https://i.ytimg.com/vi/${v}/hqdefault.jpg`,
	}
}

 
generateAddon('./kyuchek.yaml', './dist')
	.then(() => console.log('Generation complete!'))
	.catch(e => {
		console.error(e)
		process.exit(1)
	})
