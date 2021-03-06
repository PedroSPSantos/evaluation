import CSSselect from "css-select";
import { Page } from "puppeteer";
import {
  QualwebOptions,
  SourceHtml,
  ProcessedHtml,
  Url,
  Evaluator,
  Execute,
} from "@qualweb/core";
import { randomBytes } from "crypto";
import { WCAGOptions, WCAGTechniquesReport } from "@qualweb/wcag-techniques";
import { BrowserUtils, DomUtils } from "@qualweb/util";
import EvaluationRecord from "./evaluationRecord.object";
import { ACTROptions, ACTRulesReport } from "@qualweb/act-rules";
import { BPOptions, BestPracticesReport } from "@qualweb/best-practices";
import { executeWappalyzer } from "@qualweb/wappalyzer";
import { CounterReport } from "@qualweb/counter";
import { HTMLValidationReport } from "@qualweb/html-validator";

class Evaluation {
  public async getEvaluator(
    page: Page,
    sourceHtml: SourceHtml,
    url: string
  ): Promise<Evaluator> {
    const [
      plainHtml,
      pageTitle,
      elements,
      browserUserAgent,
    ] = await Promise.all([
      page.evaluate(() => {
        return document.documentElement.outerHTML;
      }),
      page.title(),
      page.$$("*"),
      page.browser().userAgent(),
    ]);

    let urlStructure: Url | undefined = undefined;
    if (url) {
      urlStructure = this.parseUrl(
        url,
        page.url() !== "about:blank" ? page.url() : url
      );
    }

    const processedHtml: ProcessedHtml = {
      html: {
        plain: plainHtml,
      },
      title: pageTitle,
      elementCount: elements.length,
    };

    const viewport = page.viewport();

    const evaluator = {
      name: "QualWeb",
      description:
        "QualWeb is an automatic accessibility evaluator for webpages.",
      version: "3.0.0",
      homepage: "http://www.qualweb.di.fc.ul.pt/",
      date: new Date().toISOString().replace(/T/, " ").replace(/\..+/, ""),
      hash: randomBytes(40).toString("hex"),
      url: urlStructure,
      page: {
        viewport: {
          mobile: !!viewport.isMobile,
          landscape: !!viewport.isLandscape,
          userAgent: browserUserAgent,
          resolution: {
            width: viewport.width,
            height: viewport.height,
          },
        },
        dom: {
          source: sourceHtml,
          processed: processedHtml,
        },
      },
    };

    return evaluator;
  }

  public async addQWPage(page: Page): Promise<void> {
    await page.addScriptTag({
      path: require.resolve("@qualweb/qw-page"),
    });
    await page.evaluate(() => {
      // @ts-ignore
      window.page = new QWPage.QWPage(document, window, true);
    });
    await page.keyboard.press("Tab"); // for R72 that needs to check the first focusable element
    await page.evaluate(() => {
      // @ts-ignore
      window.page72 = new QWPage.QWPage(document, window, true);
    });
  }

  public async executeACT(
    page: Page,
    sourceHtml: SourceHtml,
    options: ACTROptions | undefined
  ): Promise<ACTRulesReport> {
    await page.addScriptTag({
      path: require.resolve("@qualweb/act-rules"),
    });

    const metaElements = CSSselect("meta", sourceHtml.html.parsed);
    const parsedMetaElements = new Array<any>();

    for (const element of metaElements || []) {
      if (!!element) {
        const content = DomUtils.getSourceElementAttribute(element, "content");
        const httpEquiv = DomUtils.getSourceElementAttribute(
          element,
          "http-equiv"
        );
        const htmlCode = DomUtils.getSourceElementHtmlCode(
          element,
          true,
          false
        );
        const selector = DomUtils.getSourceElementSelector(element);

        parsedMetaElements.push({
          content,
          httpEquiv,
          htmlCode,
          selector,
        });
      }
    }

    const actReport = await page.evaluate(
      (parsedMetaElements, options) => {
        // @ts-ignore
        const act = new ACTRules.ACTRules(options);
        // @ts-ignore
        return act.execute(parsedMetaElements, window.page);
      },
      parsedMetaElements,
      // @ts-ignore
      options
    );

    const r40 = "QW-ACT-R40";
    const r72 = "QW-ACT-R72";

    if (
      !options ||
      !options["rules"] ||
      options["rules"].includes(r40) ||
      options["rules"].includes("59br37")
    ) {
      const viewport = page.viewport();

      await page.setViewport({
        width: 640,
        height: 512,
      });

      const actReportR40 = await page.evaluate(() => {
        // @ts-ignore
        const act = new ACTRules.ACTRules();
        // @ts-ignore
        return act.executeQW_ACT_R40(window.page);
      });

      await page.setViewport({
        width: viewport.width,
        height: viewport.height,
      });

      actReport.assertions[r40] = actReportR40;
      let outcome = actReportR40.metadata.outcome;
      if (outcome === "passed") {
        actReport.metadata.passed++;
      } else if (outcome === "failed") {
        actReport.metadata.failed++;
      } else if (outcome === "warning") {
        actReport.metadata.warning++;
      } else {
        actReport.metadata.inapplicable++;
      }
    }

    if (
      !options ||
      !options["rules"] ||
      options["rules"].includes(r72) ||
      options["rules"].includes("8a213c")
    ) {
      const actReportR72 = await page.evaluate(() => {
        // @ts-ignore
        const act = new ACTRules.ACTRules();
        // @ts-ignore
        return act.executeQW_ACT_R72(window.page72);
      });

      actReport.assertions[r72] = actReportR72;
      let outcome = actReportR72.metadata.outcome;
      if (outcome === "passed") {
        actReport.metadata.passed++;
      } else if (outcome === "failed") {
        actReport.metadata.failed++;
      } else if (outcome === "warning") {
        actReport.metadata.warning++;
      } else {
        actReport.metadata.inapplicable++;
      }
    }

    return actReport;
  }

  public async executeWCAG(
    page: Page,
    options: WCAGOptions | undefined,
    validation: HTMLValidationReport | undefined
  ): Promise<WCAGTechniquesReport> {
    await page.addScriptTag({
      path: require.resolve("@qualweb/wcag-techniques"),
    });

    const url = page.url();
    const newTabWasOpen = await BrowserUtils.detectIfUnwantedTabWasOpened(
      page.browser(),
      url
    );

    const htmlReport = await page.evaluate(
      (newTabWasOpen, validation, options) => {
        // @ts-ignore
        const html = new WCAGTechniques.WCAGTechniques(options);
        // @ts-ignore
        return html.execute(window.page, newTabWasOpen, validation);
      },
      newTabWasOpen,
      <any>validation,
      // @ts-ignore
      options
    );

    return htmlReport;
  }

  public async executeBP(
    page: Page,
    options: BPOptions | undefined
  ): Promise<BestPracticesReport> {
    await page.addScriptTag({
      path: require.resolve("@qualweb/best-practices"),
    });

    const bpReport = await page.evaluate((options) => {
      // @ts-ignore
      const bp = new BestPractices.BestPractices();
      if (options) bp.configure(options);
      // @ts-ignore
      return bp.execute(window.page);
      // @ts-ignore
    }, options);
    return bpReport;
  }

  public async executeCounter(page: Page): Promise<CounterReport> {
    await page.addScriptTag({
      path: require.resolve("@qualweb/counter"),
    });

    const Counter = <CounterReport>await page.evaluate(() => {
      //@ts-ignore
      return Counter.executeCounter(window.page);
    });
    return Counter;
  }

  public async evaluatePage(
    sourceHtml: SourceHtml,
    page: Page,
    execute: Execute,
    options: QualwebOptions,
    url: string,
    validation: HTMLValidationReport | undefined
  ): Promise<EvaluationRecord> {
    const evaluator = await this.getEvaluator(page, sourceHtml, url);
    const evaluation = new EvaluationRecord(evaluator);

    await this.addQWPage(page);

    if (execute.act) {
      evaluation.addModuleEvaluation(
        "act-rules",
        await this.executeACT(page, sourceHtml, options["act-rules"])
      );
    }
    if (execute.wcag) {
      evaluation.addModuleEvaluation(
        "wcag-techniques",
        await this.executeWCAG(page, options["wcag-techniques"], validation)
      );
    }
    if (execute.bp) {
      evaluation.addModuleEvaluation(
        "best-practices",
        await this.executeBP(page, options["best-practices"])
      );
    }
    if (execute.wappalyzer) {
      evaluation.addModuleEvaluation(
        "wappalyzer",
        await executeWappalyzer(url)
      );
    }
    if (execute.counter) {
      evaluation.addModuleEvaluation(
        "counter",
        await this.executeCounter(page)
      );
    }

    return evaluation;
  }

  private parseUrl(url: string, pageUrl: string): Url {
    const inputUrl = url;
    let protocol: string;
    let domainName: string;
    let domain: string;
    let uri: string;
    let completeUrl: string = pageUrl;

    protocol = completeUrl.split("://")[0];
    domainName = completeUrl.split("/")[2];

    const tmp: string[] = domainName.split(".");
    domain = tmp[tmp.length - 1];
    uri = completeUrl.split("." + domain)[1];

    const parsedUrl = {
      inputUrl,
      protocol,
      domainName,
      domain,
      uri,
      completeUrl,
    };

    return parsedUrl;
  }
}

export { Evaluation, EvaluationRecord };
