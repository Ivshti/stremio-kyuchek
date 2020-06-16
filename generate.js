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
	await writeToFile(path.join(addonPath, 'manifest.json'), {
		id: `com.autogen.${cat.type}`,
		name: doc.addon.name,
		version: doc.addon.version,
		description: doc.addon.description || '',
		resources: ['meta'],
		types: [cat.type],
		catalogs: [{ type: cat.type, id: 'main', name: doc.addon.name }]
	})
	await Promise.all(Object.entries(cat.items).map(([name, items]) => {
		const videos = items.filter(x => typeof x === 'string' && x.includes('youtube.com'))
		if (!videos.length) throw new Error(`catalog ${name} does not have any youtube videos listed`)
		const thumbEntry = items.find(x => x.thumb)
		const thumb = thumbEntry ? thumbEntry.thumb : videoToThumb(videos[0])
		console.log(name, videos.map(videoToThumb), thumb)
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
 
generateAddon('./kyuchek.yaml', './dist')
	.then(() => console.log('Generation complete!'))
	.catch(e => {
		console.error(e)
		process.exit(1)
	})
