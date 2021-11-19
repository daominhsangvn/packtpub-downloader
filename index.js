const got = require('got');
const fs = require('fs');
const path = require('path');
const {URL} = require('url');
const async = require('async');
const yargs = require('yargs/yargs')
const {hideBin} = require('yargs/helpers');
const slugify = require('slugify');
const tough = require('tough-cookie');
const puppeteer = require("puppeteer");
const Cookie = tough.Cookie;
const argv = yargs(hideBin(process.argv)).argv
const downloadFolder = argv.dir || 'downloads';
const username = argv.username;
const password = argv.password;

if(!username || !password) {
  throw new Error('Missing Username and Password!')
}

function ensureFolder(path) {
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path);
  }
}

const downloadPath = path.join(process.cwd(), downloadFolder);
ensureFolder(downloadPath);

const ids = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'ids.json'), 'utf8'));
const bookTemplate = fs.readFileSync(path.join(process.cwd(), 'template.html'), 'utf8');

const downloadFile = (url, output, options = {}, cb) => {
  let writeStream;

  const fn = (retryCount = 0) => {
    const stream = got.stream(url, {
      retry: {
        limit: 50,
        statusCodes: [403, 404, 408, 413, 429, 500, 502, 503, 504, 520, 521, 522, 524],
        methods: ['GET', 'PUT', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE'],
        errorCodes: ['ETIMEDOUT', 'ECONNRESET', 'EADDRINUSE', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'ENETUNREACH', 'EAI_AGAIN'],
        calculateDelay: ({computedValue}) => {
          return computedValue;
        }
      },
      ...options
    });
    stream.retryCount = retryCount;

    if (writeStream) {
      writeStream.destroy();
    }

    writeStream = fs.createWriteStream(output);

    stream.pipe(writeStream);

    stream.once('retry', fn);
    stream.once('error', (e) => {
      console.log('Download failed', url, output)
      cb(e)
    });
    stream.once('end', () => cb(null));
  };

  fn();
}

const download = (url, options = {}, cb) => {
  got(url, {
    retry: {
      limit: 50,
      statusCodes: [403, 404, 408, 413, 429, 500, 502, 503, 504, 520, 521, 522, 524],
      methods: ['GET', 'PUT', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE'],
      errorCodes: ['ETIMEDOUT', 'ECONNRESET', 'EADDRINUSE', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'ENETUNREACH', 'EAI_AGAIN'],
      calculateDelay: ({computedValue}) => {
        return computedValue;
      }
    },
    ...options
  }).then(res => cb(null, res.body)).catch(cb)
}

const normalizeFolderName = (name) => {
  return slugify(name, {remove: /[*+~.,()'"!:@?\\\/]/g}).substring(0, 50);
}

const toPdf = async (content, output, options = {}) => {
  const browser = await puppeteer.launch({ headless: true, executablePath:"/usr/bin/chromium-browser", args:['--no-sandbox','--start-maximized'] });
  const page = await browser.newPage();

  await page.setContent(content, {
    waitUntil: 'networkidle0',
    timeout: 0
  });

  await page.pdf({path: output, timeout: 5 * 60 * 1000, ...options});
  await page.close();
  await browser.close();
}

let texts = [];

(async () => {
  let lastCookie = new tough.CookieJar();

  const {body} = await got.post(`https://services.packtpub.com/auth-v1/users/tokens`, {
    json: { username, password },
    responseType: 'json'
  })

  const token = body.data.access;
  const refresh = body.data.refresh;

  async.eachOfLimit(ids, 1, (id, _, done) => {
    texts = [];
    got(`https://subscription.packtpub.com/api/products/${id}/summary`, {
      headers: {
        'Authorization': `Bearer ${token}`
      },
      responseType: 'json'
    })
      .then(({body}) => {
        const summary = body.data;

        const distFolder = path.join(downloadPath, `${id}-${normalizeFolderName(summary.title)}`);


        if (fs.existsSync(distFolder)) {
          console.log(`"${summary.title}" is already existed!`);
          return done();
        }

        ensureFolder(distFolder)

        console.log(`[+] ${summary.title} (${summary.toc.chapters.length} Chapters)`)
        fs.writeFileSync(path.join(distFolder, 'data.json'), JSON.stringify(summary, null, 4), 'utf8');

        /**
         * DOWNLOAD CHAPTERS
         */
        async.eachOfLimit(summary.toc.chapters, 1, (chapter, chapterIndex, cb) => {
          console.log(`[+] Chapter: ${chapter.title} (${chapter.sections.length} Sections)`)
          const chapFolder = path.join(distFolder, `${chapterIndex + 1}.${normalizeFolderName(chapter.title)}`);

          if(summary.type !== 'books')
            ensureFolder(chapFolder);

          /**
           * DOWNLOAD CHAPTER'S SECTIONS
           */
          async.eachOfLimit(chapter.sections, 1, (section, sectionIndex, cb2) => {
            console.log(`[+] Downloading "${section.title}" Section`)
            const sectionFolder = path.join(chapFolder, `${sectionIndex + 1}.${normalizeFolderName(section.title)}`);

            if(summary.type !== 'books')
              ensureFolder(sectionFolder);

            if (!['text', 'video'].includes(section.contentType)) {
              return cb2(new Error('Content is not supported'));
            }

            const downloadProduct = ({data: url, captions = []}, cookiejar) => {
              const headers = {}

              if (section.contentType === 'video') {
                headers['Authorization'] = `Bearer ${token}`
                headers['Range'] = `bytes=0-`
              }

              async.parallel([
                {
                  url, output: path.join(sectionFolder, path.basename(new URL(url).pathname)), options: {
                    headers: section.contentType === 'video' ? {
                      'Authorization': `Bearer ${token}`,
                      'Range': `bytes=0-`
                    } : {},
                    cookiejar
                  }
                },
                ...captions.map(c => ({
                  url: c.location,
                  output: path.join(sectionFolder, path.basename(new URL(c.location).pathname)),
                  options: {
                    cookiejar,
                    headers: {
                      'Authorization': `Bearer ${token}`
                    }
                  }
                }))
              ].map(item => {
                return (cb) => {
                  if (new URL(item.url).pathname.endsWith('.html')) {
                    download(item.url, item.options, (err, body) => {
                      if (err) {
                        cb(err)
                      } else {
                        texts.push(body)
                        cb(null);
                      }
                    });
                  } else {
                    downloadFile(item.url, item.output, item.options, cb);
                  }
                }
              }), cb2)
            }

            got(`https://subscription.packtpub.com/api/products/${id}/${chapter.id}/${section.id}`, {
              headers: {
                'Authorization': `Bearer ${token}`
              },
              responseType: 'json',
              cookiejar: lastCookie
            })
              .then((res) => {
                const {body: product, headers} = res;
                const cookies = headers['set-cookie'].map(Cookie.parse);
                // lastCookie = new tough.CookieJar();
                async.waterfall(
                  cookies.map(c => {
                    return cb => {
                      lastCookie.setCookie(c, 'https://subscription.packtpub.com/', cb);
                    }
                  }), (err) => {
                    if (err) {
                      cb2(err)
                    } else {
                      downloadProduct(product, lastCookie);
                    }
                  });
              })
              .catch(e => {
                console.log('Failed to get section info')
                cb2(e)
              })
          }, cb);
        }, function (err) {
          if (err) {
            console.error(err);
            console.log('Failed to download id (2)' + id)
            done(err);
          } else {
            console.log(`--------------------------------------------------------------`)
            console.log(``)
            if (texts.length > 0) {
              const textContent = texts.map(t => (`<div class="row">
            <div class="col-xs-12 reset-position">
                <div class="book-sections">
                    ${t}
                </div>
            </div>
        </div>`));
              const book = bookTemplate
                .replace('{body}', textContent.join(''))
                .replace('{title}', summary.title)
                .replace(/src="\/graphics\/(\d+)/g, 'src="https://static.packt-cdn.com/products/$1');
              fs.writeFileSync(path.join(distFolder, 'book.html'), book, 'utf8');
              toPdf(book, path.join(distFolder, 'book.pdf'), {
                printBackground: true,
                margin: {
                  top: 30,
                  bottom: 30,
                  left: 20,
                  right: 20
                }
              })
                .then(() => done())
                .catch(done)
            } else {
              done()
            }
          }
        });
      })
      .catch(e => {
        console.error(e);
        console.log('Failed to download id (1)' + id)
        done();
      })
  })
})()
