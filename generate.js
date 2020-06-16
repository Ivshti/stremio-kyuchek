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
		version: typeof doc.addon.version === 'string' ? doc.addon.version : `${doc.addon.version}.0.0`,
		description: doc.addon.description || '',
		resources: ['meta'],
		types: [cat.type],
		idPrefixes: [`${id}:`],
		catalogs: [{ type: cat.type, id: 'main', name: doc.addon.name }]
	})
	const catEntries = Object.entries(cat.items)
	const metas = catEntries.map(([name, items]) => {
		const videos = items
			.map(x => {
				if (typeof x === 'string' && x.includes('youtube.com')) return { url: x, title: '' }
				if (typeof x !== 'object') return null
				const entries = Object.entries(x)
				if (entries.length === 1 && entries[0][1].includes('youtube.com')) return { url: entries[0][1], title: entries[0][0] } 
			})
			.filter(x => x)
		if (!videos.length) throw new Error(`catalog ${name} does not have any youtube videos listed`)
		const thumbEntry = items.find(x => x.thumb)
		const thumb = thumbEntry ? thumbEntry.thumb : videoToThumb(videos[0])
		return {
			id: `${id}:${name}`,
			name,
			poster: thumb,
			posterShape: 'landscape',
			background: thumb,
			type: cat.type,
			videos: videos.map(videoToObject)
		}
	})
	await writeToFile(path.join(addonPath, `catalog/${cat.type}/main.json`), {
		metas: metas.map(x => ({ ...x, videos: undefined }))
	})
	await Promise.all(metas.map(meta =>
		writeToFile(path.join(addonPath, `meta/${cat.type}/${meta.id}.json`), { meta })
	))
}

async function writeToFile(fpath, content) {
	await mkdirp(path.dirname(fpath))
	await writeFile(fpath, JSON.stringify(content))
}

function videoToThumb(video) {
	const { v } = url.parse(video.url, true).query
	return `https://i.ytimg.com/vi/${v}/hqdefault.jpg`
}
function videoToObject(video) {
	const { v } = url.parse(video.url, true).query
	return {
		id: v,
		title: video.title || '',
		streams: [{ ytId: v }],
		// hack for legacy stremio
		stream: { ytId: v },
		thumbnail: `https://i.ytimg.com/vi/${v}/hqdefault.jpg`,
	}
}

 
generateAddon('./kyuchek.yaml', './dist')
	.then(() => console.log('Generation complete!'))
	.catch(e => {
		console.error(e)
		process.exit(1)
	})
