const { ApiDataSource } = require('@deity/falcon-server-env');
const qs = require('qs');
const pick = require('lodash/pick');
const isEmpty = require('lodash/isEmpty');
const isObject = require('lodash/isObject');
const uniq = require('lodash/uniq');
const Logger = require('@deity/falcon-logger');
const url = require('url');
const cheerio = require('cheerio');

module.exports = class WordpressApi extends ApiDataSource {
  async authorizeRequest(req) {
    const { username, password } = this.config;
    const token = Buffer.from(`${username}:${password}`).toString('base64');
    req.headers.set('Authorization', `Basic ${token}`);
  }

  /**
   * Resolves url based on passed parameters
   * @param {object} req - request params
   * @return {string} resolved url object
   */
  async resolveURL(req) {
    const { path, context = {} } = req;
    const { language } = context;
    const { apiPrefix, apiSuffix, language: baseLanguage } = this.config;
    let prefix = `${apiPrefix}${apiSuffix}`;

    if (language) {
      // for base lang do not add prefix
      const languagePrefix = language && language !== baseLanguage ? `/${language}` : '';
      prefix = `${languagePrefix}/${prefix}`;
    }

    return super.resolveURL({ path: `${prefix}/${path}` });
  }

  async preInitialize() {
    if (!this.context) {
      this.initialize({ context: {} });
    }
    return this.get('blog/info');
  }

  /**
   * Fetch single published post by slug
   * @param {String} slug post slug
   * @param {String} [language] post language
   * @return {Object} Post data
   */
  async getPost({ slug, language }) {
    let query = {};

    if (slug) {
      query = { ...query, slug };
    }

    query['include-gallery'] = 1;
    query['include-related'] = 1;
    query['count-visit'] = 1;

    const response = await this.getPosts({ language, query });

    const post = response[0];

    return this.extractProducts(post);
  }

  /**
   * Fetch published posts.
   * @param {String} [language] post langauge
   * @param {Object} [query] rest api query
   * @return {Object[]} posts data
   */
  async getPosts({ language, query = {} } = {}) {
    if (language) {
      query.language = language;
    }
    const response = await this.get('posts', query);

    const { data } = response;

    if (!data.items) {
      return [];
    }

    return data.items.map(item => this.reducePost({ data: item }).data);
  }

  /**
   * Parses response and returns data in format accedpted by falcon-blog-extension
   * @param {object} res object
   * @param {object} req native request object
   * @return {object} parsed response
   */
  async didReceiveResponse(res, req) {
    const data = await super.didReceiveResponse(res, req);
    const { language } = res.context;
    const languagePrefix = language && language !== this.config.language ? `/${language}` : '';
    const { headers } = res;

    let totalItems = headers.get('x-wp-total');
    let totalPages = headers.get('x-wp-totalpages');
    const responseTags = headers.get('x-cache-tags');

    const meta = {
      languagePrefix,
      language: language !== this.language ? language : null
    };

    if (responseTags) {
      meta.tags = responseTags.split(',');
    }

    if (!totalItems && !totalPages) {
      return { data, meta };
    }

    // remove everything before '?' and parse the rest
    const query = qs.parse(req.url.replace(/.*?\?/, ''));
    let { per_page: perPage = 10, page: currentPage = 1 } = query;

    totalPages = parseInt(totalPages, 10);
    totalItems = parseInt(totalItems, 10);
    perPage = parseInt(perPage, 10);
    currentPage = parseInt(currentPage, 10);

    const pagination = {
      totalPages,
      totalItems,
      perPage,
      currentPage,
      nextPage: currentPage < totalPages ? currentPage + 1 : null,
      prevPage: currentPage > 1 ? currentPage - 1 : null
    };

    return { items: data, pagination, meta };
  }

  /**
   * Removes language prefix from passed url
   * @param {String} urlToReplace - url
   * @param {String} prefix - prefix to remove
   * @returns {String} url without prefix
   */
  replaceLanguagePrefix(urlToReplace, prefix) {
    return prefix && urlToReplace.indexOf(prefix) === 0 ? urlToReplace.replace(prefix, '') : urlToReplace;
  }

  prepareLink(item, meta) {
    const { title, ID: id, url: link, acf, target } = item;
    const { languagePrefix } = meta;
    let urlPath = link;
    let isExternal = false;

    if (target === '_blank') {
      isExternal = true;
    } else {
      urlPath = this.replaceLanguagePrefix(url.parse(link).pathname, languagePrefix);
    }

    if (item.children) {
      item.children = item.children.map(this.prepareLink);
    }

    const finalItem = {
      id,
      title,
      isExternal,
      url: urlPath,
      level: Number(item.menu_item_parent) || Number(item.parent) ? 2 : 1,
      children: item.children || []
    };

    if (acf && !isEmpty(acf)) {
      finalItem.acf = acf;
    }

    return finalItem;
  }

  returnFirstItem(response) {
    const { data } = response;

    response.data = data && data.items ? data.items[0] : null;

    return response;
  }

  reducePage(response) {
    const { data: item } = response;

    if (!item) {
      response.data = {};

      return response;
    }

    const reducedItem = pick(item, ['slug', 'acf', 'id', 'featured_image']);

    reducedItem.title = item.title && item.title.rendered && this.htmlManager.stripHtmlEntities(item.title.rendered);
    reducedItem.content = item.content && item.content.rendered;
    reducedItem.featured_image = this.reduceFeaturedImage(reducedItem.featured_image);
    this.reduceAcf(reducedItem.acf);

    response.data = Object.assign(reducedItem, { type: 'wp-page' });

    return response;
  }

  reduceCategory(response) {
    const category = response.data || {};

    if (category.promoted_posts) {
      category.promoted_posts = category.promoted_posts.map(item => this.reducePost({ data: item }).data);
    }

    return response;
  }

  // todo make sure that product feature will work on SSR
  extractProducts(post) {
    const { has_products_in: hasProductsIn } = post;

    post.products = [];
    post.sectionWithProducts = [];

    if (hasProductsIn) {
      Object.keys(hasProductsIn).forEach(key => {
        // TODO: Hardcoded solution for now
        if (key === 'carousel' && post.carousel) {
          post.carousel.forEach(item => {
            if (item.content) {
              const contentHtml = cheerio.load(item.content);
              const productWidgets = contentHtml('li.deity-product');

              if (productWidgets) {
                productWidgets.map((index, el) => post.products.push(contentHtml(el).text()));
              }
            }
          });
        } else {
          const contentHtml = cheerio.load(post[key]);
          // To reduce HTML size which keeps state just overwrite content with flag
          post.sectionWithProducts.push(key);

          contentHtml('li.deity-product').map((index, el) => post.products.push(contentHtml(el).text()));
        }
      });

      post.products = uniq(post.products);
    }

    return post;
  }

  reduceRelatedPost(post) {
    // todo reduce to same format as normal post to clean components
    post.title = this.htmlManager.stripHtmlEntities(post.title);

    return post;
  }

  prepareExcerpt(data = {}, lenght = 145) {
    let content = '';

    if (isObject(data) && data.rendered) {
      content = data.rendered;
    } else if (data) {
      content = data;
    }

    content = this.htmlManager.stripHtmlEntities(content);

    return this.htmlManager.generateExcerpt(content, lenght);
  }

  reduceFeaturedImage(image) {
    return {
      url: image.url,
      description: image.description,
      // todo remove from core
      sizes: pick(image.sizes, [
        'thumbnail',
        'bones-thumb-search',
        'photo-l-land',
        'category-landing',
        'bones-thumb-590',
        'slide'
      ])
    };
  }

  /* eslint-disable no-unused-vars */
  /**
   * Project can define it's own custom field processing logic for example to reduce size of acf related payload
   * @param {Object} content custom fields values
   */
  reduceAcf(content) {}
  /* eslint-enable no-unused-vars */

  reducePost(response) {
    const post = response.data || {};
    const image = post && post.featured_image;

    if (image) {
      post.image = this.reduceFeaturedImage(image);
    }

    if (post.related_posts) {
      post.related = post.related_posts.map(this.reduceRelatedPost);
    } else {
      post.related = [];
    }

    if (post.title && post.title.rendered) {
      post.title = this.htmlManager.stripHtmlEntities(post.title.rendered);
    }

    if (post.content) {
      const excerpt =
        (post.acf && post.acf.short_description) ||
        (post.toolset_types && post.toolset_types['custom-text']) ||
        post.content;
      let length;

      if (post.acf && post.acf.short_description) {
        length = 250;
      }

      this.reduceAcf(post.acf);

      post.excerpt = this.prepareExcerpt(excerpt, length);
    }

    post.content = post.content && post.content.rendered;
    post.title = this.htmlManager.stripHtmlTags(post.title);

    response.data = post;

    return response;
  }

  isDraft(link) {
    return link && link.indexOf('preview/') === 0;
  }

  /**
   * Make sure that pathname that will be checked always starts and ends with '/'
   * @param {String} pathname to convert
   * @return {String} converted pathname
   */
  preparePathname(pathname) {
    let path = pathname;

    if (!pathname.startsWith('/')) {
      path = `/${path}`;
    }

    if (!pathname.endsWith('/')) {
      path = `${path}/`;
    }

    return path;
  }

  /**
   * Based on api response check if requested pathname contains redirect
   *
   * @param {String} dataPath - pathname from wordpress api response
   * @param {String} requestedPath - pathname requested by client
   * @return {String|Boolean} - pathname if has redirect or false
   */
  isEntityRedirect(dataPath, requestedPath) {
    if (dataPath !== requestedPath && !this.isDraft(dataPath)) {
      return dataPath;
    }

    return false;
  }

  getFetchUrlPriority() {
    return this.fetchUrlPriority;
  }

  /**
   * Fetch wordpress url based on pathname and check if it contains any redirect.
   * Convert response based on data type (page | post | category )
   *
   * @param {Object} params request params
   * @param {String} params.path - pathname of wordpress url
   * @param {String} [params.language] - wordpress language
   * @param {Object} [params.headers] - for request todo find usage ? draft ?
   * @return {Object} response - with reduced and converted data
   */
  //  async fetchUrl({ path, headers = {}, language }) {
  async fetchUrl(path, language) {
    const params = { path };
    if (language) {
      params.language = language;
    }

    const response = await this.get('url', { path }, { authRequired: this.isDraft(path), language });

    const {
      data,
      meta: { languagePrefix }
    } = response;

    const type = `wp-${data.type}`;
    data.url = this.replaceLanguagePrefix(data.url, languagePrefix);
    const redirect = this.isEntityRedirect(this.preparePathname(data.url), this.preparePathname(path));
    let reducer;

    // todo rename to post
    // todo remove what is not used ?
    if (type === 'wp-post') {
      reducer = notReducedData => this.extractProducts(this.reducePost(notReducedData));
    } else if (type === 'wp-page') {
      reducer = this.reducePage;
    } else if (type === 'wp-category') {
      reducer = this.reduceCategory;
    } else {
      Logger.warn(`No reducer defined for Wordpress entity: ${type} `);
    }

    let responseData = {};

    if (reducer) {
      responseData = reducer(data).data;
    }

    response.data = Object.assign(responseData, { url: data.url, redirect, type });

    return response;
  }
};
